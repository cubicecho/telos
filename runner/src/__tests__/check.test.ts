import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkEnv, runCheck } from '../check.ts';

// A check's command, run for real through the shell: what it is handed, what
// comes back, and that a time limit or a stop ends it.

let dir: string;
const signal = new AbortController().signal;
const env = { PATH: process.env.PATH, HOME: '/home/check', RUNNER_KEY: 'runner-secret', DATABASE_URL: 'postgres://x' };

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'telos-check-')));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('runCheck', () => {
  it('reports the exit code and what was printed, both streams', async () => {
    const result = await runCheck(
      { command: 'echo out; echo err >&2; exit 4', timeoutSeconds: null },
      { signal, cwd: dir, env },
    );
    expect(result).toMatchObject({ exitCode: 4, timedOut: false });
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
  });

  it('runs where it is told, with none of the runner’s secrets', async () => {
    const result = await runCheck(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion, read by the shell
      { command: 'pwd; echo "key=${RUNNER_KEY:-none} db=${DATABASE_URL:-none} home=$HOME"', timeoutSeconds: null },
      { signal, cwd: dir, env },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(dir);
    expect(result.output).toContain('key=none db=none home=/home/check');
  });

  it('keeps only the end of a long output', async () => {
    const result = await runCheck(
      { command: 'for i in $(seq 1 2000); do echo "line $i"; done', timeoutSeconds: null },
      { signal, cwd: dir, env, settings: { outputTailChars: 100 } },
    );
    expect(result.output.length).toBe(100);
    expect(result.output).toContain('line 2000');
  });

  it('kills a command that runs out of time, and what it started', async () => {
    const started = Date.now();
    const result = await runCheck(
      { command: 'sleep 30 & sleep 30; echo never', timeoutSeconds: 1 },
      { signal, cwd: dir, env, settings: { killGraceMs: 200 } },
    );
    expect(result).toMatchObject({ exitCode: null, timedOut: true });
    expect(result.output).not.toContain('never');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('stops when asked', async () => {
    const stop = new AbortController();
    const running = runCheck({ command: 'sleep 30', timeoutSeconds: null }, { signal: stop.signal, cwd: dir, env });
    setTimeout(() => stop.abort(), 100);
    expect(await running).toMatchObject({ exitCode: null, timedOut: false });
  });

  it('fails, rather than throws, for a command that cannot start', async () => {
    const result = await runCheck(
      { command: 'true', timeoutSeconds: null },
      { signal, cwd: join(dir, 'missing'), env },
    );
    expect(result.exitCode).toBeNull();
    expect(result.output).toContain('could not be started');
  });
});

describe('checkEnv', () => {
  it('passes only the short allowlist', () => {
    expect(checkEnv({ PATH: '/bin', LANG: 'C', OPENAI_API_KEY: 'sk', RUNNER_KEY: 'k' })).toEqual({
      PATH: '/bin',
      LANG: 'C',
    });
  });
});
