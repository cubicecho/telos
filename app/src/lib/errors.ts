/**
 * Turn whatever a failed query or mutation threw into one sentence a person
 * can act on.
 *
 * Apollo hands back an `ApolloError` whose own `message` is a concatenation
 * built for a log, and whose network failures read as the browser's
 * "Failed to fetch" — which tells a reader nothing about what to do next.
 * Everything that shows a failure goes through here so the app has one
 * vocabulary for going wrong rather than one per call site.
 */

/** What a browser says when the request never reached anything. */
const FETCH_FAILURES = [
  // Chrome
  'failed to fetch',
  // Firefox
  'networkerror when attempting to fetch resource.',
  // Safari
  'load failed',
];

const UNREACHABLE = 'Couldn’t reach the server.';
const UNKNOWN = 'Something went wrong.';

/** The bits of `ApolloError` this reads, without importing the class. */
interface ErrorLike {
  message?: unknown;
  graphQLErrors?: readonly { message?: unknown }[];
  networkError?: { message?: unknown; statusCode?: unknown } | null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function describeError(error: unknown): string {
  if (error == null) return UNKNOWN;
  if (typeof error === 'string') return text(error) ?? UNKNOWN;
  if (typeof error !== 'object') return UNKNOWN;

  const like = error as ErrorLike;

  // A GraphQL error first, always: the server got the request, understood it
  // and refused it, so it knows more about why than anything downstream does.
  // "Cannot delete the last lane" beats "Response not successful: 400".
  const fromServer = like.graphQLErrors?.map((entry) => text(entry.message)).find(Boolean);
  if (fromServer) return fromServer;

  // A status means the server answered, so quote it — an authentication
  // failure and an unplugged cable want different reactions from the reader.
  const network = like.networkError;
  if (network) {
    const status = typeof network.statusCode === 'number' ? network.statusCode : undefined;
    if (status === 401 || status === 403) return 'Your session has expired. Sign in again.';
    if (status != null) return `The server answered ${status}.`;
    return UNREACHABLE;
  }

  const message = text(like.message);
  if (!message) return UNKNOWN;
  // The browser's own wording for a request that went nowhere, replaced rather
  // than shown: it names a function nobody called and no cause.
  if (FETCH_FAILURES.includes(message.toLowerCase())) return UNREACHABLE;
  return message;
}
