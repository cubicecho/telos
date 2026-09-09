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
