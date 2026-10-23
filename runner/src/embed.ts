import { configWarnings, readConfig } from './config.ts';
import { runLoop } from './loop.ts';
import { createTelos } from './telos.ts';

// The runner inside the server's own process, which is how telos ships it: the
// server makes up a key at boot and hands it over here, so there is nothing to
// configure. It still reaches telos only over HTTP, as the system principal,
// exactly as a runner on another host would.

export interface EmbeddedRunner {
  /** Ends the loop; runs in flight are reported as stopped. Resolves when they have been. */
  stop(): Promise<void>;
}

/**
 * Starts the runner loop in this process.
 *
 * @param options.telosUrl Where the server is listening.
 * @param options.runnerKey The key the server accepts as x-runner-key.
 * @param options.env Where the tuning settings (the poll interval) are read from.
 * @returns A handle to stop it.
 */
export function startRunner(options: { telosUrl: string; runnerKey: string; env?: NodeJS.ProcessEnv }): EmbeddedRunner {
  const env = options.env ?? process.env;
  const config = readConfig({ ...env, TELOS_URL: options.telosUrl, RUNNER_KEY: options.runnerKey });
  // readConfig is only null without a key, and one was just given.
  if (!config) throw new Error('startRunner needs a runner key');
  const abort = new AbortController();
  for (const warning of configWarnings(env)) console.warn(warning);
  const done = runLoop({ ...config, telos: createTelos(config) }, abort.signal);
  return {
    stop() {
      abort.abort();
      return done;
    },
  };
}
