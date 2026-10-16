import { GraphQLError } from 'graphql';

// The API's failures, by code. A message teaches the fix: what was wrong and
// what to do instead. Codes only one place throws (CURSOR_EXPIRED,
// UNAUTHENTICATED, TOO_MANY_REQUESTS) are built where they are thrown.

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
