import { describe, expect, it } from 'vitest';
import { describeError } from '../errors';

/** An `ApolloError` as far as `describeError` is concerned. */
function apolloError(fields: {
  message?: string;
  graphQLErrors?: { message: string }[];
  networkError?: { message?: string; statusCode?: number } | null;
}) {
  return { graphQLErrors: [], networkError: null, message: '', ...fields };
}

describe('describeError', () => {
  it('prefers what the server said', () => {
    const error = apolloError({
      message: 'Response not successful: Received status code 400',
      graphQLErrors: [{ message: 'A project must keep at least one lane.' }],
      networkError: { message: 'Response not successful', statusCode: 400 },
    });
    // The server understood the request and refused it, so it knows more about
    // why than the transport does.
    expect(describeError(error)).toBe('A project must keep at least one lane.');
  });

  it('takes the first of several GraphQL errors', () => {
    const error = apolloError({ graphQLErrors: [{ message: 'First.' }, { message: 'Second.' }] });
    expect(describeError(error)).toBe('First.');
  });

  it('skips a GraphQL error with nothing in it', () => {
    const error = apolloError({ graphQLErrors: [{ message: '  ' }, { message: 'The real one.' }] });
    expect(describeError(error)).toBe('The real one.');
  });

  it('names the status when the server answered at all', () => {
    expect(describeError(apolloError({ networkError: { statusCode: 500 } }))).toBe('The server answered 500.');
  });

  it('says to sign in again on an expired session', () => {
    expect(describeError(apolloError({ networkError: { statusCode: 401 } }))).toBe(
      'Your session has expired. Sign in again.',
    );
    expect(describeError(apolloError({ networkError: { statusCode: 403 } }))).toBe(
      'Your session has expired. Sign in again.',
    );
  });

  it('says the server was unreachable when the request went nowhere', () => {
    expect(describeError(apolloError({ networkError: { message: 'Failed to fetch' } }))).toBe(
      'Couldn’t reach the server.',
    );
  });

  it('replaces a bare browser fetch failure, whichever browser wrote it', () => {
    for (const message of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed']) {
      expect(describeError(new Error(message))).toBe('Couldn’t reach the server.');
    }
    // Case is the browser's business, not ours.
    expect(describeError(new Error('failed to fetch'))).toBe('Couldn’t reach the server.');
  });

  it('passes a plain error through', () => {
    expect(describeError(new Error('A todo cannot depend on itself.'))).toBe('A todo cannot depend on itself.');
  });

  it('falls back rather than rendering an empty line or an object', () => {
    expect(describeError(new Error(''))).toBe('Something went wrong.');
    expect(describeError(null)).toBe('Something went wrong.');
    expect(describeError(undefined)).toBe('Something went wrong.');
    expect(describeError(42)).toBe('Something went wrong.');
    expect(describeError({})).toBe('Something went wrong.');
  });

  it('accepts a string, because a rejected promise may carry one', () => {
    expect(describeError('Nope.')).toBe('Nope.');
    expect(describeError('   ')).toBe('Something went wrong.');
  });
});
