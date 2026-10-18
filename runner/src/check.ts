import { type ChildProcess, spawn } from 'node:child_process';
import { MINIMAL_CHILD_ENV } from '@cubicecho/agent-mcp-pool';
import { CHECK_DEFAULTS, type CheckSettings } from './defaults.ts';
import type { CheckResult, ClaimedCheck } from './telos.ts';

// A check lane's run: no agent, just a person's shell command, whose exit code
// telos reads as the verdict. It runs here, on the runner's host and with the
// runner's rights, never in the server. What it is handed is kept small on
// purpose: the runner's own directory (until each todo has a workspace of its
// own), a short list of environment variables and none of this process's
// secrets, and a time limit after which it is killed.

/** Why a check is refused on a runner that does not run users' commands. */
export const CHECKS_OFF =
  'This runner does not run check commands. A check is a shell command on the runner’s host, ' +
  'so it runs only where RUNNER_ALLOW_STDIO=true says every user with AI on may run one.';

export interface CheckOptions {
  /** Stops the command: telos asked, or the runner is shutting down. */
  signal: AbortSignal;
  /** Where the command runs. The runner's own working directory unless a test says otherwise. */
  cwd?: string;
  /** The environment to pick the allowed variables from. This process's unless a test says otherwise. */
  env?: NodeJS.ProcessEnv;
  /** Overrides of `CHECK_DEFAULTS`, for a test. */
  settings?: Partial<CheckSettings>;
}

/**
 * The environment a check runs with: only the variables a shell and the usual
 * tools need (agent-mcp-pool's `MINIMAL_CHILD_ENV`). The runner's key, the
 * server's database URL and any provider key stay behind.
 *
 * @param env The environment to pick from.
 * @returns The variables the command gets.
 */
export function checkEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of MINIMAL_CHILD_ENV) {
    const value = env[name];
    if (value !== undefined) picked[name] = value;
  }
  return picked;
}

/**
 * Runs a check's command through the system shell and reports what it did.
 * It never throws for the command's sake: one that cannot start, fails, or
 * runs out of time is a result, and telos rules it a fail.
 *
 * @param check What the lane runs, and for how long.
 * @param options Its stop signal, and where and with what it runs.
 * @returns Its exit code (null if it did not exit by itself), whether it ran out of time, and the end of its output.
 */
export function runCheck(check: ClaimedCheck, options: CheckOptions): Promise<CheckResult> {
  const settings = { ...CHECK_DEFAULTS, ...options.settings };
  const timeoutMs = (check.timeoutSeconds ?? settings.timeoutSeconds) * 1000;
  let output = '';
  const keep = (text: string) => {
    output = (output + text).slice(-settings.outputTailChars);
  };

  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    let child: ChildProcess;
    try {
      child = spawn(check.command, {
        shell: true,
        cwd: options.cwd ?? process.cwd(),
        env: checkEnv(options.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        // Its own process group, so a stop reaches what the shell started too.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      resolve({ exitCode: null, timedOut: false, output: `It could not be started: ${messageOf(error)}` });
      return;
    }

    let grace: NodeJS.Timeout | undefined;
    const stop = () => {
      kill(child, 'SIGTERM');
      grace ??= setTimeout(() => kill(child, 'SIGKILL'), settings.killGraceMs);
    };
    const limit = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    options.signal.addEventListener('abort', stop, { once: true });
    if (options.signal.aborted) stop();

    child.stdout?.setEncoding('utf8').on('data', keep);
    child.stderr?.setEncoding('utf8').on('data', keep);

    const done = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      clearTimeout(grace);
      options.signal.removeEventListener('abort', stop);
      resolve({ exitCode, timedOut, output });
    };
    child.on('error', (error) => {
      keep(`\nIt could not be started: ${error.message}`);
      done(null);
    });
    // `close`, not `exit`: by then everything it printed has been read.
    child.on('close', (code) => done(timedOut ? null : code));
  });
}

/**
 * Signals a check's whole process group, or the child alone where there are
 * no groups. The group, even once the shell has exited: what it started may
 * still hold the pipes open. One that is already gone is not an error.
 *
 * @param child The shell.
 * @param signal What to send.
 */
function kill(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // It ended between the check and the signal.
  }
}

/**
 * What went wrong, as a string.
 *
 * @param error What was thrown.
 * @returns Its message.
 */
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
