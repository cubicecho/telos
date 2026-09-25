import { randomUUID } from 'node:crypto';

// "Test this MCP server", passed through: a person asks here, the runner dials
// it (the server never imports agent code, and the runner is where the tools
// will be reached from, so it is the one whose answer counts), and the answer
// waits here for the person to read it. In memory: a test is a question asked
// now, and a restart that forgets one costs a click.

export interface ProbeTool {
  name: string;
  description: string;
}

export interface McpProbe {
  id: string;
  userId: string;
  /** The server row, as JSON, as the runner reads an agent's. */
  server: string;
  status: 'pending' | 'testing' | 'done';
  ok: boolean;
  tools: ProbeTool[];
  instructions: string;
  error: string | null;
  askedAt: number;
}

/** How long a test waits for the runner to take it before saying nobody did. */
export const PROBE_PICKUP_MS = 15_000;
/** How long a test is kept at all. The runner gives a server ten seconds. */
export const PROBE_TTL_MS = 2 * 60_000;
/** The most tests one person may have waiting: a button, not a scanner. */
export const PROBE_LIMIT = 5;

const probes = new Map<string, McpProbe>();

function sweep(now: number): void {
  for (const [id, probe] of probes) {
    if (now - probe.askedAt > PROBE_TTL_MS) probes.delete(id);
    else if (probe.status === 'pending' && now - probe.askedAt > PROBE_PICKUP_MS) {
      Object.assign(probe, { status: 'done', ok: false, error: 'No runner picked the test up. Is one running?' });
    }
  }
}

/**
 * Asks for a server to be tested.
 *
 * @param userId Who asked; only they may read the answer.
 * @param server The server row, as JSON.
 * @returns The test, or null when they already have too many waiting.
 */
export function askProbe(userId: string, server: string): McpProbe | null {
  const now = Date.now();
  sweep(now);
  const waiting = [...probes.values()].filter((probe) => probe.userId === userId && probe.status !== 'done');
  if (waiting.length >= PROBE_LIMIT) return null;
  const probe: McpProbe = {
    id: randomUUID(),
    userId,
    server,
    status: 'pending',
    ok: false,
    tools: [],
    instructions: '',
    error: null,
    askedAt: now,
  };
  probes.set(probe.id, probe);
  return probe;
}

/**
 * A test, for the person who asked for it.
 *
 * @param id The test.
 * @param userId Who is asking.
 * @returns It, or null when it is gone or not theirs.
 */
export function readProbe(id: string, userId: string): McpProbe | null {
  sweep(Date.now());
  const probe = probes.get(id);
  return probe && probe.userId === userId ? probe : null;
}

/**
 * The tests waiting for the runner, now marked taken.
 *
 * @returns Them.
 */
export function takeProbes(): McpProbe[] {
  sweep(Date.now());
  const pending = [...probes.values()].filter((probe) => probe.status === 'pending');
  for (const probe of pending) probe.status = 'testing';
  return pending;
}

/**
 * Records what the runner found.
 *
 * @param id The test.
 * @param result What the server said, or why it could not be reached.
 * @returns Whether the test was still there to finish.
 */
export function finishProbe(
  id: string,
  result: { ok: boolean; tools: ProbeTool[]; instructions: string; error: string | null },
): boolean {
  const probe = probes.get(id);
  if (!probe || probe.status === 'done') return false;
  Object.assign(probe, { ...result, status: 'done' });
  return true;
}

/** Forgets every test. For tests. */
export function clearProbes(): void {
  probes.clear();
}
