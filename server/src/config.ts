/** Truthy env-var values: "1", "true", "yes" (case-insensitive). */
export function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
}

/** Falsy env-var values: "0", "false", "no" (case-insensitive). */
function envDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'no'].includes((value ?? '').trim().toLowerCase());
}

/**
 * Whether signing in requires following a magic link at all.
 *
 * With `AUTH_MAGIC_LINK=false`, `requestMagicLink` hands back a live session for
 * whatever address it is given: there is no second factor and no link to follow.
 * That is a deliberate convenience for a self-hosted instance on a private
 * network. Anyone who can reach the port can then sign in as anyone, so it must
 * never be set on an instance exposed to the internet.
 */
export function magicLinkRequired(): boolean {
  return !envDisabled(process.env.AUTH_MAGIC_LINK);
}

/**
 * Whether the magic link is returned in the API response rather than only being
 * logged server-side.
 *
 * On outside production, or anywhere `EXPOSE_MAGIC_LINK` is set — which is what
 * a self-hosted instance with no mail provider wants, since the link has nowhere
 * else to go. Same warning as above: on a public deployment this lets anyone who
 * knows an address sign in as its owner.
 */
export function magicLinkExposed(): boolean {
  return process.env.NODE_ENV !== 'production' || envFlag(process.env.EXPOSE_MAGIC_LINK);
}

/** What signs sessions when nothing is configured. preflight.ts refuses it in production. */
export const DEV_SECRET = 'dev-secret-change-in-production';

/**
 * The secret better-auth signs with. `AUTH_SECRET`, or `JWT_SECRET` for an
 * instance configured before sessions moved to better-auth.
 */
export function authSecret(): string {
  return process.env.AUTH_SECRET || process.env.JWT_SECRET || DEV_SECRET;
}

/**
 * Where magic links point. In production the server serves the client itself,
 * so its own origin is the right default, but only for someone browsing from
 * this machine. Set APP_URL to the address users actually type; a link to
 * `localhost` is useless in an inbox.
 */
export function appUrl(): string {
  return process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
}

/**
 * The instance's AI switch, off unless `AI_ENABLED` says otherwise. Off, the
 * AI surface does not exist: no `/mcp`, no API keys, no AI fields in the
 * schema, and every account's own switch is moot.
 */
export function aiEnabled(): boolean {
  return envFlag(process.env.AI_ENABLED);
}

/**
 * The runner's key, which the runner sends as `x-runner-key` to act as the
 * system principal (resolvers/runs.ts). Unset, nothing can claim a run, which
 * is the right answer for an instance that runs no agents.
 */
export function runnerKey(): string | null {
  return process.env.RUNNER_KEY?.trim() || null;
}
