import { createHmac, timingSafeEqual } from 'node:crypto';
import { authSecret } from './config.ts';

// A run token is what an agent presents while it works: `claimRun` hands one to
// the runner, and the agent's own connection back to telos (its MCP tools)
// carries it as `x-run-token`. It names the run and nothing else. Who the
// agent acts for, and whether it may still act at all, is looked up from the
// run on every request (auth.ts `resolveActor`), so a token dies with its run
// — finished, cancelled, lease lapsed or AI switched off — and needs no
// expiry of its own.

/** What run tokens start with, so a leaked one is recognisable. */
export const RUN_TOKEN_PREFIX = 'telos_run_';

/**
 * The signature over a run id.
 *
 * @param runId The run the token names.
 * @param secret What signs it; the instance's auth secret by default.
 * @returns The signature, base64url.
 */
function sign(runId: string, secret: string): string {
  return createHmac('sha256', secret).update(`run:${runId}`).digest('base64url');
}

/**
 * Mints the token for a run.
 *
 * @param runId The run the token names.
 * @param secret What signs it; the instance's auth secret by default.
 * @returns The token.
 */
export function mintRunToken(runId: string, secret: string = authSecret()): string {
  return `${RUN_TOKEN_PREFIX}${runId}.${sign(runId, secret)}`;
}

/**
 * The run a token names, if its signature holds.
 *
 * @param token What the caller sent.
 * @param secret What signed it; the instance's auth secret by default.
 * @returns The run id, or null for anything that is not a token this instance minted.
 */
export function readRunToken(token: string, secret: string = authSecret()): string | null {
  if (!token.startsWith(RUN_TOKEN_PREFIX)) return null;
  const [runId, signature] = token.slice(RUN_TOKEN_PREFIX.length).split('.');
  if (!runId || !signature) return null;
  const expected = Buffer.from(sign(runId, secret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given) ? runId : null;
}

/**
 * Compares a presented runner key with the configured one in constant time.
 *
 * @param given What the caller sent.
 * @param configured The instance's runner key, or null when none is set.
 * @returns Whether they match; always false with no key configured.
 */
export function runnerKeyMatches(given: string, configured: string | null | undefined): boolean {
  if (!configured) return false;
  const a = createHmac('sha256', 'runner').update(given).digest();
  const b = createHmac('sha256', 'runner').update(configured).digest();
  return timingSafeEqual(a, b);
}
