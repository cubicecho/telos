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
  };
}

/**
 * What the runner says about its settings as it starts: settings it no longer
 * reads. None stops it. An old `RUNNER_ALLOW_STDIO`, `RUNNER_ALLOW_CHECKS` or
 * `RUNNER_CONCURRENCY` is said rather than refused, since a compose file of an
 * earlier release sets it whether or not anyone chose to.
 *
 * @param env The environment the settings were read from.
 * @returns One line for each, to warn with.
 */
export function configWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];
  if (env.RUNNER_ALLOW_STDIO?.trim()) {
    warnings.push(
      '⚠️  RUNNER_ALLOW_STDIO is no longer read: telos does not run stdio MCP servers, only ones at a URL. ' +
        'Remove RUNNER_ALLOW_STDIO.',
    );
  }
  if (env.RUNNER_CONCURRENCY?.trim()) {
    warnings.push(
      "⚠️  RUNNER_CONCURRENCY is no longer read: how many runs work at once is the instance's run limit, " +
        'which an admin sets in Settings → Agents. Remove RUNNER_CONCURRENCY.',
    );
  }
  if (env.RUNNER_ALLOW_CHECKS?.trim()) {
    warnings.push(
      '⚠️  RUNNER_ALLOW_CHECKS is no longer read: check lanes were removed, and telos runs no commands on ' +
        "the runner's host. Remove RUNNER_ALLOW_CHECKS.",
    );
  }
  return warnings;
}
