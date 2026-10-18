import {
  ApolloClient,
  ApolloLink,
  type FetchResult,
  from,
  HttpLink,
  InMemoryCache,
  Observable,
  type Operation,
  split,
} from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { onError } from '@apollo/client/link/error';
import { getMainDefinition } from '@apollo/client/utilities';
import { print } from 'graphql';
import { type Client, createClient } from 'graphql-sse';
import { Platform } from 'react-native';
import { clearToken, getToken } from '@/lib/auth';

// Empty means "same origin", which is what production wants: the server serves
// the built client from the same place it serves /graphql.
//
// `npm run dev:app` is the exception — Expo serves the client from its own port,
// so the API has to be named. Take the host from whatever address the page was
// actually opened on: hardcoding localhost works only for the machine running
// the dev server, and breaks the moment you open the app from a phone or a
// second laptop. EXPO_PUBLIC_API_URL overrides this outright.
function devApiUrl(): string {
  if (process.env.NODE_ENV === 'production' || Platform.OS !== 'web') return '';
  return `${window.location.protocol}//${window.location.hostname}:${process.env.EXPO_PUBLIC_API_PORT ?? '3001'}`;
}

/** Where the API is: empty for the page's own origin. */
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? devApiUrl();

const httpLink = new HttpLink({ uri: `${API_URL}/graphql` });

/**
 * Subscriptions (a live board) as Server-Sent Events from the same /graphql,
 * one stream per subscription (graphql-sse's distinct-connections mode, which
 * is what the server's Yoga speaks). A stream opens with its subscription and
 * closes with it, so a screen that watches nothing holds nothing open.
 */
class SseLink extends ApolloLink {
  private readonly sse: Client;

  constructor(sse: Client) {
    super();
    this.sse = sse;
  }

  public request(operation: Operation): Observable<FetchResult> {
    return new Observable((sink) =>
      this.sse.subscribe(
        { ...operation, query: print(operation.query) },
        {
          // An ExecutionResult off the wire is the FetchResult Apollo's sink takes.
          next: (result) => sink.next(result as FetchResult),
          complete: () => sink.complete(),
          error: (error) => sink.error(error),
        },
      ),
    );
  }
}

const sseLink = new SseLink(
  createClient({
    url: `${API_URL}/graphql`,
    // Read on every connect, so a new sign-in is the one that counts. Unlike a
    // socket, a stream is a fetch, so the token rides in the usual header.
    headers: (): Record<string, string> => {
      const token = getToken();
      return token ? { authorization: `Bearer ${token}` } : {};
    },
    retryAttempts: Number.POSITIVE_INFINITY,
    on: {
      // Changes made while the stream was down were never announced, so a
      // reconnect refetches what is on screen rather than trusting it.
      connected: (reconnected) => {
        if (reconnected) void client.refetchQueries({ include: 'active' });
      },
    },
  }),
);

const authLink = setContext((_operation, { headers }) => {
  const token = getToken();
  return {
    headers: {
      ...headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  };
});

// UNAUTHENTICATED means the session is gone, not that this particular request
// was refused — so drop the token and start over rather than leaving the app in
// a state where every query fails.
const errorLink = onError(({ graphQLErrors }) => {
  if (graphQLErrors?.some((error) => error.extensions?.code === 'UNAUTHENTICATED')) {
    clearToken();
    if (Platform.OS === 'web' && !window.location.pathname.startsWith('/login')) {
      window.location.replace('/login');
    }
  }
});

// A relation list is replaced, never merged.
//
// Apollo's default for a list field is to overwrite it and warn that data may be
// lost, because it cannot know whether the incoming array is the whole list or a
// page of it. Here it is always the whole list: every one of these fields is
// derived by the server from the rows it owns, and the client rederives the
// blocking pair the same way, so a shorter array is the answer rather than a
// partial view of it. Removing the last dependency really does leave `blockedBy`
// empty, and merging that into what was there would keep a blocker the todo no
// longer has.
//
// `merge: false` says exactly that, and silences the warning it was right to
// raise about a cache that had not decided.
const replace = { merge: false } as const;

const cache = new InMemoryCache({
  typePolicies: {
    // The root lists too: each set of arguments is its own entry, always the
    // whole answer for them (a longer page is asked for with a new limit), so a
    // shorter one after an archive or a delete is the list as it now stands.
    Query: {
      fields: {
        projects: replace,
        todos: replace,
        lanes: replace,
        labels: replace,
        runs: replace,
        artifacts: replace,
        agents: replace,
        mcpServers: replace,
        boardTemplates: replace,
      },
    },
    Todo: {
      fields: {
        thread: replace,
        history: replace,
        blockedBy: replace,
        dependencies: replace,
        dependents: replace,
        labels: replace,
        runs: replace,
        artifacts: replace,
      },
    },
    Run: { fields: { artifacts: replace } },
    Project: { fields: { labels: replace, todos: replace, lanes: replace } },
    Lane: { fields: { todos: replace } },
    Label: { fields: { todos: replace, projects: replace } },
  },
});

export const client = new ApolloClient({
  cache,
  link: from([
    errorLink,
    split(
      ({ query }) => {
        const definition = getMainDefinition(query);
        return definition.kind === 'OperationDefinition' && definition.operation === 'subscription';
      },
      sseLink,
      from([authLink, httpLink]),
    ),
  ]),
});
