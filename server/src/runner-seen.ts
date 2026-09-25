// When the runner last asked for work, so a person can tell a quiet board
// from a runner that is not there. Kept in memory: it is about this server's
// runner, now, and a restart that forgets it hears from the runner again
// within seconds.

let seenAt: Date | null = null;

/** Notes that the runner asked for work just now. */
export function markRunnerSeen(): void {
  seenAt = new Date();
}

/** When the runner last asked for work, or null if it has not since this server started. */
export function runnerSeenAt(): Date | null {
  return seenAt;
}
