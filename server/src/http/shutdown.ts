import type { Server } from 'node:http';
import { HTTP_DEFAULTS, type HttpSettings } from '../core/defaults.ts';

const MS_PER_SECOND = 1000;

/** What runs around the drain. */
export interface ShutdownSteps {
  /** Stops starting new work (the runner, pruning). Runs as soon as the signal arrives. */
  before?: () => unknown;
  /** Closes what requests were using (MCP streams). Runs once the server has drained. */
  after?: () => Promise<unknown>;
}

/**
 * On SIGTERM or SIGINT: stops accepting, lets in-flight requests finish, cuts
 * what is still open once the drain time is up (a live board's stream never
 * finishes on its own), closes, exits. A second signal exits at once.
 *
 * @param server - The listening server.
 * @param [steps] - Work to stop before the drain, and resources to close after it.
 * @param [overrides] - Settings that differ from `HTTP_DEFAULTS`.
 */
export function stopOnSignals(
  server: Server,
  { before, after }: ShutdownSteps = {},
  overrides: Partial<HttpSettings> = {},
): void {
  const settings = { ...HTTP_DEFAULTS, ...overrides };
  let isStopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (isStopping) process.exit(1);
    isStopping = true;
    console.log(`[server] ${signal}: draining`);
    setTimeout(() => {
      console.error('[server] shutdown took too long, exiting');
      process.exit(1);
    }, settings.shutdownDeadlineSeconds * MS_PER_SECOND).unref();
    try {
      await before?.();
      const drained = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      // A client reconnects a cut stream on its own, and refetches what it shows.
      const cutOff = setTimeout(() => server.closeAllConnections(), settings.drainSeconds * MS_PER_SECOND);
      await drained;
      clearTimeout(cutOff);
      await after?.();
    } catch (error) {
      console.error('[server] shutdown failed:', error);
      process.exit(1);
    }
    console.log('[server] stopped');
    process.exit(0);
  };
  process.on('SIGTERM', (signal) => void stop(signal));
  process.on('SIGINT', (signal) => void stop(signal));
}
