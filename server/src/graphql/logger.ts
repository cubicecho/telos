import { GraphQLError } from 'graphql';
import type { YogaLogger } from 'graphql-yoga';

// Yoga masks every unexpected error as "Unexpected error." for the client, and
// logs the original through its `logging` option. That line is the only place
// the real cause ever appears, so it gets the tag every other line has.
// Operation variables are never logged: sign-in's carry tokens.

/**
 * Picks what to print for one logged value. A masked error prints its path and
 * its cause, which carries the real stack.
 *
 * @param value - What Yoga logged.
 * @returns The values to print.
 */
const describe = (value: unknown): unknown[] => {
  const isMasked = value instanceof GraphQLError && value.originalError !== undefined;
  if (isMasked) return [value.path?.join('.') ?? '', value.originalError];
  return [value];
};

/** Yoga's logger with the `[graphql]` tag. */
export const graphqlLogger: YogaLogger = {
  // Yoga narrates every request at debug level.
  debug: () => {},
  info: (...args) => console.info('[graphql]', ...args),
  warn: (...args) => console.warn('[graphql]', ...args),
  error: (...args) => console.error('[graphql]', ...args.flatMap(describe)),
};
