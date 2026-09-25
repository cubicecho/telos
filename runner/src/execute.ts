import { parseJson, preselect, runAgentLoop } from '@cubicecho/agent-core';
import type { McpPool } from '@cubicecho/agent-mcp-pool';
import { briefPrompt, proposedTodos, systemPromptFor } from './prompts.ts';
import type { Claim, RunResult, Telos } from './telos.ts';
import { openTools } from './tools.ts';

// One run, start to finish: open the agent's tools, run the loop, keep the
// lease, and tell telos what came of it. What happens to the todo is not
// decided here — finishRun reads the result against the lane.

/** How often a run renews its lease. Telos gives a claim two minutes. */
export const HEARTBEAT_MS = 30_000;

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
  const beat = setInterval(() => {
    options.telos.heartbeat(claim.runId).then(
      (halt) => {
        if (halt && !stopRequested) {
          stopRequested = true;
          log('telos asked this run to stop');
          stop.abort(new Error('Stopped.'));
        }
      },
      (error) => log(`heartbeat failed: ${messageOf(error)}`),
    );
  }, options.heartbeatMs ?? HEARTBEAT_MS);

  let pool: McpPool | null = null;
  let result: RunResult;
  try {
    pool = await (options.open ?? openTools)(claim, {
      telosUrl: options.telosUrl,
      allowStdio: options.allowStdio,
      onNotice: log,
    });
    result = await work(claim, pool, stop.signal, log);
  } catch (error) {
    result = stop.signal.aborted ? { status: 'stopped' } : { status: 'error', error: messageOf(error) };
  } finally {
    clearInterval(beat);
    options.signal?.removeEventListener('abort', onOuterAbort);
    await pool?.shutdown().catch((error: unknown) => log(`closing tools failed: ${messageOf(error)}`));
  }

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
 * The agent loop over one run.
 *
 * @param claim The run.
 * @param pool Its tools.
 * @param signal Stops it.
 * @param log Where notices go.
 * @returns The result to report.
 */
async function work(claim: Claim, pool: McpPool, signal: AbortSignal, log: (text: string) => void): Promise<RunResult> {
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
    tools: pool.tools(),
    ...(catalog ? { catalog } : {}),
    preselected,
    dispatch: (call, callSignal) => pool.call(call.name, call.args, { signal: callSignal ?? signal }),
    signal,
    onEvent: (event) => {
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
