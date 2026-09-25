// What the runner reads from its environment. It needs two things to do
// anything: where telos is, and the key telos knows it by. Without either it
// has nothing to talk to, and says so rather than guessing.

export interface RunnerConfig {
  /** Telos's origin. GraphQL is at /graphql and the agents' door at /mcp under it. */
  telosUrl: string;
  /** The server's RUNNER_KEY, sent as x-runner-key. */
  runnerKey: string;
  /** How long to wait between asks when the queue was empty. */
  pollMs: number;
  /** The most runs this process works at once, across every user. */
  concurrency: number;
  /**
   * Whether an agent may name an MCP server to spawn as a command. Off by
   * default: agents belong to the board's users, and a command runs on this
   * host with this process's rights. Turn it on only when every user with AI on
   * is someone you would hand a shell.
   */
  allowStdio: boolean;
}

/**
 * Reads the runner's settings.
 *
 * @param env The environment to read.
 * @returns The settings, or null when TELOS_URL or RUNNER_KEY is missing.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig | null {
  const telosUrl = env.TELOS_URL?.trim() || `http://127.0.0.1:${env.PORT ?? 3001}`;
  const runnerKey = env.RUNNER_KEY?.trim();
  if (!runnerKey) return null;
  return {
    telosUrl: telosUrl.replace(/\/+$/, ''),
    runnerKey,
    pollMs: Math.max(1, Number(env.RUNNER_POLL_SECONDS) || 5) * 1000,
    concurrency: Math.max(1, Number(env.RUNNER_CONCURRENCY) || 2),
    allowStdio: env.RUNNER_ALLOW_STDIO === 'true',
  };
}
