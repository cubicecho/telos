import { type ExecuteOptions, execute } from './execute.ts';
import { takeTests } from './probes.ts';
import type { Telos } from './telos.ts';

// The runner's heartbeat as a process: ask telos what is ready, claim what it
// has room for, work it, ask again. It keeps no state of its own worth losing —
// a run it was working when it died is written off by its lease lapsing, and
// the todo comes back to the queue.

export interface LoopOptions extends Omit<ExecuteOptions, 'signal'> {
  telos: Telos;
  concurrency: number;
  pollMs: number;
}

/**
 * Claims and starts whatever is ready, up to the free slots.
 *
 * @param options How to reach telos and how much to take on.
 * @param running The runs in flight, by run id. Added to here.
 * @param signal Stops the runs started.
 * @returns How many runs were started.
 */
export async function tick(
  options: LoopOptions,
  running: Map<string, Promise<unknown>>,
  signal?: AbortSignal,
): Promise<number> {
  const room = options.concurrency - running.size;
  if (room <= 0) return 0;
  let started = 0;
  for (const ready of await options.telos.queue(room * 2)) {
    if (started >= room) break;
    // Null is someone else got there first, or it stopped being ready.
    const claim = await options.telos.claim(ready.todoId, ready.laneId);
    if (!claim) continue;
    started++;
    const run = execute(claim, { ...options, ...(signal ? { signal } : {}) }).finally(() =>
      running.delete(claim.runId),
    );
    running.set(claim.runId, run);
  }
  return started;
}

/**
 * Runs until `signal` aborts, then waits for the runs in flight to stop.
 *
 * @param options How to reach telos and how much to take on.
 * @param signal Ends the loop.
 * @returns When the loop and its runs are done.
 */
export async function runLoop(options: LoopOptions, signal: AbortSignal): Promise<void> {
  const running = new Map<string, Promise<unknown>>();
  const log = options.log ?? console.log;
  while (!signal.aborted) {
    try {
      await takeTests(options.telos, options.allowStdio, log);
    } catch (error) {
      log(`[runner] asking telos for MCP tests failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    let started = 0;
    try {
      started = await tick(options, running, signal);
    } catch (error) {
      log(`[runner] asking telos failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    // Straight back round when there was work and room for more; otherwise wait.
    if (started > 0 && running.size < options.concurrency) continue;
    await pause(options.pollMs, signal, running);
  }
  await Promise.allSettled(running.values());
}

/**
 * Waits out the poll interval, or less: a run finishing frees a slot, and a
 * stop ends the wait.
 *
 * @param ms The interval.
 * @param signal Ends the wait.
 * @param running The runs in flight.
 * @returns When it is time to ask again.
 */
function pause(ms: number, signal: AbortSignal, running: Map<string, Promise<unknown>>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    for (const run of running.values()) run.finally(done);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
