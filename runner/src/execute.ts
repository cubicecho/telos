import {
  type HookContext,
  type HookNote,
  type HookRunner,
  notify,
  parseJson,
  preselect,
  type RunEventInput,
  runAgentLoop,
} from '@cubicecho/agent-core';
import type { McpPool } from '@cubicecho/agent-mcp-pool';
import {
  ArtifactLog,
  declaredArtifact,
  detectArtifact,
  RECORD_ARTIFACT,
  RECORD_ARTIFACT_DEFINITION,
} from './artifacts.ts';
import { briefPrompt, proposedTodos, systemPromptFor } from './prompts.ts';
import type { Claim, RunEvent, RunResult, Telos } from './telos.ts';
import { openTools } from './tools.ts';

// One run, start to finish: open the agent's tools, run the loop, keep the
// lease, and tell telos what came of it. What happens to the todo is not
// decided here — finishRun reads the result against the lane.

/**
 * How often a run renews its lease and sends what it has done since. Telos
 * gives a claim two minutes; this is often because it is also the live view's
 * refresh.
 */
export const HEARTBEAT_MS = 10_000;

/** Every hook's `{{host}}`, so a server shared with other hosts can tell them apart. */
export const HOST = 'telos';

/** The most of a tool's arguments or answer an event carries. Telos cuts again. */
const EVENT_TEXT_CHARS = 2000;

/**
 * What a run has done since it last told telos. The heartbeat and the finish
 * drain it; a heartbeat that fails puts its events back.
 */
class EventFeed {
  #pending: RunEvent[] = [];

  push(event: RunEvent): void {
    this.#pending.push({ ...event, text: event.text?.slice(0, EVENT_TEXT_CHARS) ?? null });
  }

  drain(): RunEvent[] {
    const drained = this.#pending;
    this.#pending = [];
    return drained;
  }

  restore(events: RunEvent[]): void {
    this.#pending = [...events, ...this.#pending];
  }

  /**
   * The loop's events worth a watcher's time: tool traffic and notices. Tokens
   * as they stream are left to the finish's output.
   *
   * @param event What agent-core emitted.
   */
  fromLoop(event: RunEventInput): void {
    if (event.kind === 'tool-call' || event.kind === 'tool-result') {
      this.push({
        kind: event.kind === 'tool-call' ? 'tool_call' : 'tool_result',
        name: event.name ?? null,
        ok: event.ok ?? null,
        text: event.text ?? null,
      });
    } else if (event.kind === 'notice') {
      this.push({ kind: 'notice', name: event.name || null, text: event.text ?? null });
    }
  }

  /**
   * A hook's note: what it added, or why it added nothing.
   *
   * @param note What agent-core said about the hook.
   */
  fromHook(note: HookNote): void {
    const tokens = note.tokens ? ` (+${note.tokens} tokens)` : '';
    const summary = `${note.event} · ${note.source}/${note.hookId}${note.error ? `: ${note.error}` : tokens}`;
    this.push({
      kind: 'hook',
      name: note.source,
      ok: !note.error,
      text: note.text ? `${summary}\n\n${note.text}` : summary,
    });
  }
}

/** Defaults for what an agent left blank. */
const DEFAULTS = { maxTokens: 4096, temperature: 0.2, requestTimeoutSeconds: 300, maxRetries: 2 };

export interface ExecuteOptions {
  telos: Telos;
  telosUrl: string;
  allowStdio: boolean;
  heartbeatMs?: number;
  /** Stops the run from outside, as a shutdown does. */
  signal?: AbortSignal;
  /** Opens the run's tools; `openTools` unless a test says otherwise. */
  open?: typeof openTools;
  log?: (text: string) => void;
}

/**
 * What went wrong, as a string.
 *
 * @param error What was thrown.
 * @returns Its message.
 */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Works one claimed run and reports it.
 *
 * @param claim What `claimRun` handed over.
 * @param options Telos, and how to reach it.
 * @returns What was reported.
 */
export async function execute(claim: Claim, options: ExecuteOptions): Promise<RunResult> {
  const log = options.log ?? ((text: string) => console.log(`[run ${claim.runId.slice(0, 8)}] ${text}`));
  const stop = new AbortController();
  const onOuterAbort = () => stop.abort(new Error('The runner is shutting down.'));
  options.signal?.addEventListener('abort', onOuterAbort, { once: true });

  // The lease is the only thing keeping another runner off this todo, and the
  // heartbeat is how telos says stop: a switch turned off, or a person's cancel.
  let stopRequested = false;
  const feed = new EventFeed();
  const artifacts = new ArtifactLog();
  const beat = setInterval(() => {
    const events = feed.drain();
    options.telos.heartbeat(claim.runId, events).then(
      (halt) => {
        if (halt && !stopRequested) {
          stopRequested = true;
          log('telos asked this run to stop');
          stop.abort(new Error('Stopped.'));
        }
      },
      (error) => {
        feed.restore(events);
        log(`heartbeat failed: ${messageOf(error)}`);
      },
    );
  }, options.heartbeatMs ?? HEARTBEAT_MS);

  let pool: McpPool | null = null;
  let result: RunResult;
  // The todo is the session and this run a turn of it, so a memory server
  // files a todo's work run and its review run under the same id.
  const hookContext: HookContext = {
    session: { id: claim.todoId },
    host: HOST,
    vars: { todoId: claim.todoId, runId: claim.runId, lane: claim.brief.laneName, contract: claim.brief.contract },
  };
  try {
    pool = await (options.open ?? openTools)(claim, {
      telosUrl: options.telosUrl,
      allowStdio: options.allowStdio,
      onNotice: (text) => {
        feed.push({ kind: 'notice', text });
        log(text);
      },
    });
    result = await work(claim, pool, { signal: stop.signal, log, feed, artifacts, hookContext });
  } catch (error) {
    result = stop.signal.aborted ? { status: 'stopped' } : { status: 'error', error: messageOf(error) };
  } finally {
    clearInterval(beat);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
  try {
    // Every run ends, whatever became of it. Not on the run's signal: a run
    // that was stopped has not asked for its end not to be heard.
    if (pool)
      await notify(hooksOf(pool, log), 'sessionEnd', { ...hookContext, status: result.status }, (note) =>
        feed.fromHook(note),
      );
  } finally {
    await pool?.shutdown().catch((error: unknown) => log(`closing tools failed: ${messageOf(error)}`));
  }
  result = { ...result, events: feed.drain(), artifacts: artifacts.list() };

  log(`${result.status}${result.error ? `: ${result.error}` : ''}`);
  try {
    await options.telos.finish(claim.runId, result);
  } catch (error) {
    // Most likely the lease lapsed and telos already wrote this run off.
    log(`finishing failed: ${messageOf(error)}`);
  }
  return result;
}

/**
 * The pool's hooks as agent-core runs them, failures logged.
 *
 * @param pool The run's servers.
 * @param log Where failures go.
 * @returns The runner.
 */
function hooksOf(pool: McpPool, log: (text: string) => void): HookRunner {
  return (event, context, { signal }) =>
    pool.runHooks(event, context, { ...(signal ? { signal } : {}), onNotice: (text) => log(`[hooks] ${text}`) });
}

interface WorkOptions {
  signal: AbortSignal;
  log: (text: string) => void;
  feed: EventFeed;
  artifacts: ArtifactLog;
  hookContext: HookContext;
}

/**
 * The agent loop over one run.
 *
 * @param claim The run.
 * @param pool Its tools.
 * @param options Its signal, and where what it does goes.
 * @returns The result to report.
 */
async function work(claim: Claim, pool: McpPool, options: WorkOptions): Promise<RunResult> {
  const { signal, log, feed, artifacts } = options;
  const { agent, brief } = claim;
  const prompt = briefPrompt(brief);
  const config = {
    baseUrl: agent.baseUrl,
    apiKey: agent.apiKey ?? '',
    model: agent.model,
    maxTokens: agent.maxTokens ?? DEFAULTS.maxTokens,
    temperature: agent.temperature ?? DEFAULTS.temperature,
    requestTimeoutSeconds: agent.requestTimeoutSeconds ?? DEFAULTS.requestTimeoutSeconds,
    maxRetries: agent.maxRetries ?? DEFAULTS.maxRetries,
    maxToolIterations: agent.maxToolIterations,
    toolDiscovery: agent.toolDiscovery ? ('ondemand' as const) : ('eager' as const),
    ...(agent.contextLength ? { contextLength: agent.contextLength } : {}),
  };
  const catalog = agent.toolDiscovery ? pool.catalog() : undefined;
  const preselected =
    catalog?.length && agent.toolSelectModel
      ? await preselect(config, agent.toolSelectModel, catalog, prompt, { signal, onNotice: log }).catch(() => [])
      : [];

  const loop = await runAgentLoop({
    config,
    system: systemPromptFor(brief, agent.systemPrompt),
    messages: [{ role: 'user', content: prompt }],
    tools: [...pool.tools(), RECORD_ARTIFACT_DEFINITION],
    ...(catalog ? { catalog, loaded: [RECORD_ARTIFACT] } : {}),
    preselected,
    dispatch: async (call, callSignal) => {
      if (call.name === RECORD_ARTIFACT) {
        const declared = declaredArtifact(call.args);
        if (!declared) throw new Error('record_artifact needs a location.');
        artifacts.add(declared);
        return `Recorded ${declared.location}.`;
      }
      const answer = await pool.call(call.name, call.args, { signal: callSignal ?? signal });
      artifacts.add(detectArtifact(call.name, call.args));
      return answer;
    },
    signal,
    hooks: {
      run: hooksOf(pool, log),
      context: { ...options.hookContext, prompt },
      onNote: (note) => feed.fromHook(note),
    },
    onEvent: (event) => {
      feed.fromLoop(event);
      if (event.kind === 'notice') log(event.text ?? '');
    },
  });

  const output = loop.turn.content.trim();
  const spent = {
    toolCalls: loop.toolCalls.length,
    promptTokens: loop.usage.prompt,
    completionTokens: loop.usage.completion,
    totalTokens: loop.usage.total,
  };
  if (brief.contract === 'expand') {
    return { status: 'ok', output, todos: proposedTodos(parseJson<unknown>(output)), ...spent };
  }
  return { status: 'ok', output, ...spent };
}
