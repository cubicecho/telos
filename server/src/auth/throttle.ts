import type { Context } from '../core/context.ts';

/** The sign-in steps that are throttled. Each has its own budget. */
export const AuthFlow = {
  SignInMagicLink: 'sign-in-magic-link',
  MagicLinkVerify: 'magic-link-verify',
  VerifyOneTimeToken: 'verify-one-time-token',
} as const;
export type AuthFlow = (typeof AuthFlow)[keyof typeof AuthFlow];

/**
 * Counts one sign-in attempt, and throws once the caller has made too many.
 *
 * Two keys, because each stops what the other cannot: the address stops one
 * inbox being buried from many machines, and the client's IP stops one machine
 * walking through many addresses. A step with no address yet (spending a
 * token) counts by IP alone.
 *
 * @param context - The request's context, for its limiter and client IP.
 * @param flow - Which sign-in step this is.
 * @param [email] - The normalized address, when the step names one.
 */
export function throttle(context: Pick<Context, 'ip' | 'limiter'>, flow: AuthFlow, email?: string): void {
  const keys = [`${flow}:ip:${context.ip}`];
  if (email !== undefined) keys.push(`${flow}:email:${email}`);
  context.limiter.hit(...keys);
}
