// Every tunable value the runner's checks use, as plain data. Nothing here
// computes, reads the environment or imports. A test passes an override where
// the check is run; nothing edits a group at runtime: each group is frozen.

/** How a check lane's command is run (check.ts). */
export interface CheckSettings {
  /** How long a command may run when its lane names no limit. */
  timeoutSeconds: number;
  /** How much of what it prints, from the end, is kept and sent to telos. */
  outputTailChars: number;
  /** How long a command asked to stop (SIGTERM) has before it is killed (SIGKILL). */
  killGraceMs: number;
}

export const CHECK_DEFAULTS: Readonly<CheckSettings> = Object.freeze({
  timeoutSeconds: 600,
  outputTailChars: 4000,
  killGraceMs: 5000,
});
