import { GraphQLError } from 'graphql';

// The API's failures, by code. A message teaches the fix: what was wrong and
// what to do instead. Codes only one place throws (CURSOR_EXPIRED,
// UNAUTHENTICATED) are built where they are thrown.

/**
 * A row the caller cannot see: it does not exist, or it is not theirs.
 *
 * @param what - What was asked for, as a sentence starts it ("Todo").
 * @returns A NOT_FOUND error.
 */
export function notFound(what: string): GraphQLError {
  return new GraphQLError(`${what} not found`, { extensions: { code: 'NOT_FOUND' } });
}

/**
 * Arguments the API will not take.
 *
 * @param message - What is wrong with them, and what would do.
 * @returns A BAD_USER_INPUT error.
 */
export function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/**
 * A write the row's state does not allow now.
 *
 * @param message - What is in the way.
 * @returns A CONFLICT error.
 */
export function conflict(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'CONFLICT' } });
}

/**
 * Something the caller may not do, whatever the arguments.
 *
 * @param message - Who may, or what to do instead.
 * @returns A FORBIDDEN error.
 */
export function forbidden(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'FORBIDDEN' } });
}

/**
 * Too many attempts at something that is throttled (sign-in).
 *
 * @param message - When to try again, as a sentence.
 * @param retryAfter - Seconds until the caller may try again.
 * @returns A TOO_MANY_REQUESTS error carrying `retryAfter`.
 */
export function rateLimited(message: string, retryAfter: number): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'TOO_MANY_REQUESTS', retryAfter } });
}

/**
 * The message of anything caught, for a log line. Never for a client: a caught
 * error reaches one only through a coded error with a message written for it.
 *
 * @param error - Whatever was thrown.
 * @returns `error.message` for an Error, otherwise `String(error)`.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
