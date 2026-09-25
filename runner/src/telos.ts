// The runner's whole view of telos: four operations over GraphQL, as the
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
  url?: string;
  command?: string;
  args?: string[];
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ClaimedAgent {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  systemPrompt: string | null;
  temperature: number | null;
  maxTokens: number | null;
  contextLength: number | null;
  maxToolIterations: number;
  toolDiscovery: boolean;
  toolSelectModel: string | null;
  requestTimeoutSeconds: number | null;
  maxRetries: number | null;
  /** JSON, as telos sends it. */
  mcpServers: string;
}

export interface Brief {
  projectName: string;
  projectDescription: string | null;
  projectContext: string | null;
  laneName: string;
  contract: 'work' | 'verdict' | 'expand';
  lanePrompt: string | null;
  title: string;
  brief: string | null;
  acceptance: string | null;
  report: string | null;
  why: string | null;
  notes: string[];
}

export interface Claim {
  runId: string;
  todoId: string;
  token: string;
  leaseExpiresAt: string;
  agent: ClaimedAgent;
  brief: Brief;
}

export interface ProposedTodo {
  title: string;
  brief?: string | null;
  acceptance?: string | null;
  dependsOn?: string[] | null;
}

export interface RunResult {
  status: 'ok' | 'error' | 'stopped';
  output?: string | null;
  error?: string | null;
  toolCalls?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  todos?: ProposedTodo[];
}

/** The runner's calls into telos. An interface so a test can stand in for it. */
export interface Telos {
  queue(limit?: number): Promise<ReadyTodo[]>;
  claim(todoId: string, laneId: string): Promise<Claim | null>;
  /** True means stop. */
  heartbeat(runId: string): Promise<boolean>;
  finish(runId: string, result: RunResult): Promise<void>;
}

const QUEUE = `query ($limit: Int) { runnerQueue(limit: $limit) { todoId laneId projectId } }`;
const CLAIM = `mutation ($todoId: ID!, $laneId: ID!) {
  claimRun(todoId: $todoId, laneId: $laneId) {
    runId todoId token leaseExpiresAt
    agent {
      id name baseUrl model apiKey systemPrompt temperature maxTokens contextLength
      maxToolIterations toolDiscovery toolSelectModel requestTimeoutSeconds maxRetries mcpServers
    }
    brief {
      projectName projectDescription projectContext laneName contract lanePrompt
      title brief acceptance report why notes
    }
  }
}`;
const HEARTBEAT = `mutation ($id: ID!) { heartbeatRun(id: $id) }`;
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
    heartbeat: async (runId) => (await request<{ heartbeatRun: boolean }>(HEARTBEAT, { id: runId })).heartbeatRun,
    finish: async (runId, result) => {
      await request(FINISH, { id: runId, result });
    },
  };
}
