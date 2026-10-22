import type { ArtifactDraft } from './artifacts.ts';
import type { KeyedLayer } from './spec.ts';
// The runner's whole view of telos: a handful of operations over GraphQL, as the
// system principal. The runner never touches the database; every rule about
// what may run, and what a finished run does to a todo, is telos's.

export interface ReadyTodo {
  todoId: string;
  laneId: string;
  projectId: string;
}

export interface McpServerRow {
  id: string;
  name?: string;
  /** Where the server is: telos reaches MCP servers over HTTP only. */
  url?: string;
  /**
   * A stdio server's command, which only a telos from before stdio servers were
   * removed would send. Never run: read only to say why the server is left out.
   */
  command?: unknown;
  headers?: Record<string, string>;
  /** Overrides of the pool's limits, in milliseconds. Absent, the pool's. */
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  /** How long it may sit unused before it is closed; 0 is never. */
  idleTimeoutMs?: number;
  /** This server's tools the model is not offered, for its hooks' use. */
  hiddenTools?: string[];
  /** Tool calls it wants made around a run: `ToolHook`s, as agent-mcp-pool reads them. */
  hooks?: unknown[];
}

/** Something that happened in a run, for the live view. */
export interface RunEvent {
  kind: 'tool_call' | 'tool_result' | 'hook' | 'notice' | 'turn' | 'thinking' | 'output';
  name?: string | null;
  ok?: boolean | null;
  text?: string | null;
}

/**
 * An agent as telos stores it: what it says, null where it inherits from its
 * account's `defaults`. `resolveAgent` (spec.ts) layers the two.
 */
export interface ClaimedAgent {
  id: string;
  name: string;
  baseUrl: string | null;
  model: string | null;
  apiKey: string | null;
  systemPrompt: string | null;
  temperature: number | null;
  maxTokens: number | null;
  contextLength: number | null;
  maxToolIterations: number | null;
  toolDiscovery: boolean | null;
  toolSelectModel: string | null;
  reasoningEffort: string | null;
  requestTimeoutSeconds: number | null;
  maxRetries: number | null;
  /** The account's layer under it, key included; null where the account has set none. */
  defaults: (KeyedLayer & { apiKey: string | null }) | null;
  /** The account's servers it reaches, as JSON, as telos sends it. */
  mcpServers: string;
  /** What telos has to say about them: a server the agent names that is gone. */
  mcpNotices: string[];
}

/** A check lane's command, which the runner runs in place of an agent (check.ts). */
export interface ClaimedCheck {
  command: string;
  /** Null is the runner's default (`CHECK_DEFAULTS`). */
  timeoutSeconds: number | null;
}

/** What a check's command did. Telos reads the verdict off it: exit 0 passes. */
export interface CheckResult {
  /** Null when it did not exit by itself: killed, or never started. */
  exitCode: number | null;
  timedOut: boolean;
  /** The end of what it printed, stdout and stderr together. */
  output: string;
}

export interface Assignment {
  /** What every agent of the account is told, whichever project it works in. */
  globalContext: string | null;
  projectName: string;
  projectDescription: string | null;
  projectContext: string | null;
  /** The project's standing instructions to its agents, a person's own. */
  projectPrompt: string | null;
  laneName: string;
  title: string;
  brief: string | null;
  acceptance: string | null;
  /** The last work report; telos leaves it out for a lane that reviews work. */
  report: string | null;
  why: string | null;
  notes: string[];
  /** Whether the lane reviews work, and so rules on the work rather than on a report of it. */
  reviews: boolean;
  /** The last ruling on the todo, from any lane. */
  ruling: string | null;
  /** What has been made for the todo, newest first. */
  artifacts: AssignedArtifact[];
}

/** Something made for a todo, as a run is told of it. */
export interface AssignedArtifact {
  location: string;
  action: string;
  title: string | null;
}

export interface Claim {
  runId: string;
  todoId: string;
  token: string;
  leaseExpiresAt: string;
  /** How many runs the todo had before this one: zero for its first. */
  turn: number;
  /** Whether no agent has worked the todo before: its hooks' session opens with this run. */
  opensSession: boolean;
  /** The lane's agent; null for a check lane. */
  agent: ClaimedAgent | null;
  /** The lane's check; null for an agent's lane. */
  check: ClaimedCheck | null;
  assignment: Assignment;
}

/** A claim of an agent's lane: what opening tools and running the loop need. */
export type AgentClaim = Claim & { agent: ClaimedAgent };

export interface ProposedTodo {
  title: string;
  brief?: string | null;
  acceptance?: string | null;
  dependsOn?: string[] | null;
}

/** A todo as its run rewrote it: a field left out stays as it was. */
export interface RefinedTodo {
  title?: string | null;
  brief?: string | null;
  acceptance?: string | null;
}

export interface RunResult {
  status: 'ok' | 'error' | 'stopped';
  output?: string | null;
  error?: string | null;
  toolCalls?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** How many of `promptTokens` the endpoint served from its prompt cache. */
  cachedInputTokens?: number;
  todos?: ProposedTodo[];
  refine?: RefinedTodo | null;
  events?: RunEvent[];
  /** What the agent was told, when no heartbeat got it there first. */
  prompt?: RunPrompt;
  artifacts?: ArtifactDraft[];
  /** What a check run's command did. */
  check?: CheckResult;
}

/** What a run's agent was told. */
export interface RunPrompt {
  system: string;
  user: string;
}

/** What a run has spent so far, from its start. */
export interface RunUsage {
  toolCalls?: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** How many of `promptTokens` came from the endpoint's prompt cache. */
  cachedInputTokens?: number;
}

/** What a heartbeat carries besides the lease: what happened since the last one. */
export interface Beat {
  events?: RunEvent[];
  /** Sent until telos has it. */
  prompt?: RunPrompt;
  usage?: RunUsage;
}

/** A test of an MCP server somebody asked for: the row, as JSON. */
export interface RunnerProbe {
  id: string;
  server: string;
}

export interface ProbeResult {
  ok: boolean;
  tools: Array<{ name: string; description: string }>;
  instructions?: string;
  error?: string | null;
}

/** A deleted todo's session, which one agent's servers have yet to be told is gone. */
export interface SessionDelete {
  id: string;
  /** The todo that was deleted: the session's id. */
  todoId: string;
  agentName: string;
  /** The servers the agent reaches that have a `sessionDelete` hook, as JSON. */
  mcpServers: string;
}

/** The runner's calls into telos. An interface so a test can stand in for it. */
export interface Telos {
  queue(limit?: number): Promise<ReadyTodo[]>;
  claim(todoId: string, laneId: string): Promise<Claim | null>;
  /** True means stop. */
  heartbeat(runId: string, beat?: Beat): Promise<boolean>;
  finish(runId: string, result: RunResult): Promise<void>;
  /** MCP server tests waiting to be made, now taken. */
  probes(): Promise<RunnerProbe[]>;
  finishProbe(id: string, result: ProbeResult): Promise<void>;
  /** Deleted todos whose sessions' servers are still to be told, now taken. */
  sessionDeletes(limit?: number): Promise<SessionDelete[]>;
  /** With `error`, the servers could not be told. */
  finishSessionDelete(id: string, error?: string | null): Promise<void>;
}

const QUEUE = `query ($limit: Int) { runnerQueue(limit: $limit) { todoId laneId projectId } }`;
/** What the runner reads of an agent, for a run. */
const AGENT_FIELDS = `
  id name baseUrl model apiKey systemPrompt temperature maxTokens contextLength
  maxToolIterations toolDiscovery toolSelectModel reasoningEffort requestTimeoutSeconds maxRetries mcpServers mcpNotices
  defaults {
    baseUrl model apiKey temperature maxTokens contextLength
    maxToolIterations toolDiscovery toolSelectModel reasoningEffort requestTimeoutSeconds maxRetries
  }
`;
const CLAIM = `mutation ($todoId: ID!, $laneId: ID!) {
  claimRun(todoId: $todoId, laneId: $laneId) {
    runId todoId token leaseExpiresAt turn opensSession
    agent { ${AGENT_FIELDS} }
    check { command timeoutSeconds }
    assignment {
      globalContext projectName projectDescription projectContext projectPrompt laneName
      title brief acceptance report why notes reviews ruling
      artifacts { location action title }
    }
  }
}`;
const HEARTBEAT = `mutation ($id: ID!, $events: [RunEventInput!], $prompt: RunPromptInput, $usage: RunUsageInput) {
  heartbeatRun(id: $id, events: $events, prompt: $prompt, usage: $usage)
}`;
const PROBES = `query { runnerProbes { id server } }`;
const FINISH_PROBE = `mutation ($id: ID!, $result: ProbeResultInput!) { finishProbe(id: $id, result: $result) }`;
const SESSION_DELETES = `mutation ($limit: Int) { takeSessionDeletes(limit: $limit) { id todoId agentName mcpServers } }`;
const FINISH_SESSION_DELETE = `mutation ($id: ID!, $error: String) { finishSessionDelete(id: $id, error: $error) }`;
/**
 * Events as the API takes them: `RunEventKind` is SCREAMING_CASE on the wire,
 * and the runner says `tool_call`.
 *
 * @param events The events, if any.
 * @returns The events to send.
 */
function wireEvents(events: RunEvent[] | undefined) {
  return events?.map((event) => ({ ...event, kind: event.kind.toUpperCase() }));
}

const FINISH = `mutation ($id: ID!, $result: RunResultInput!) { finishRun(id: $id, result: $result) { id } }`;

/** A GraphQL answer carrying errors, as one error. */
export class TelosError extends Error {
  readonly codes: string[];

  /**
   * @param errors What telos said.
   */
  constructor(errors: Array<{ message: string; extensions?: { code?: string } }>) {
    super(errors.map((error) => error.message).join('; '));
    this.name = 'TelosError';
    this.codes = errors.map((error) => error.extensions?.code ?? 'UNKNOWN');
  }
}

/**
 * A client for telos's runner operations.
 *
 * @param options Where telos is and the runner's key.
 * @param options.telosUrl Telos's origin.
 * @param options.runnerKey Sent as x-runner-key.
 * @param options.fetch The fetch to use; the global one by default.
 * @returns The client.
 */
export function createTelos(options: { telosUrl: string; runnerKey: string; fetch?: typeof fetch }): Telos {
  const send = options.fetch ?? fetch;

  /**
   * Sends one operation.
   *
   * @param query The operation.
   * @param variables Its variables.
   * @returns Its data.
   */
  async function request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await send(`${options.telosUrl}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-runner-key': options.runnerKey },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await response.json().catch(() => null)) as {
      data?: T;
      errors?: Array<{ message: string; extensions?: { code?: string } }>;
    } | null;
    if (body?.errors?.length) throw new TelosError(body.errors);
    if (!response.ok || !body?.data) throw new Error(`telos answered ${response.status}`);
    return body.data;
  }

  return {
    queue: async (limit = 20) => (await request<{ runnerQueue: ReadyTodo[] }>(QUEUE, { limit })).runnerQueue,
    claim: async (todoId, laneId) => (await request<{ claimRun: Claim | null }>(CLAIM, { todoId, laneId })).claimRun,
    heartbeat: async (runId, beat = {}) =>
      (
        await request<{ heartbeatRun: boolean }>(HEARTBEAT, {
          id: runId,
          events: wireEvents(beat.events) ?? [],
          prompt: beat.prompt ?? null,
          usage: beat.usage ?? null,
        })
      ).heartbeatRun,
    finish: async (runId, result) => {
      // `RunOutcome` is SCREAMING_CASE on the wire; the runner and its hooks say `ok`.
      await request(FINISH, {
        id: runId,
        result: { ...result, status: result.status.toUpperCase(), events: wireEvents(result.events) },
      });
    },
    probes: async () => (await request<{ runnerProbes: RunnerProbe[] }>(PROBES, {})).runnerProbes,
    finishProbe: async (id, result) => {
      await request(FINISH_PROBE, { id, result });
    },
    sessionDeletes: async (limit = 5) =>
      (await request<{ takeSessionDeletes: SessionDelete[] }>(SESSION_DELETES, { limit })).takeSessionDeletes,
    finishSessionDelete: async (id, error = null) => {
      await request(FINISH_SESSION_DELETE, { id, error });
    },
  };
}
