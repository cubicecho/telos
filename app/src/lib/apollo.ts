import { ApolloClient, from, HttpLink, InMemoryCache, split } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { onError } from '@apollo/client/link/error';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { getMainDefinition } from '@apollo/client/utilities';
import { createClient } from 'graphql-ws';
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

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? devApiUrl();

const httpLink = new HttpLink({ uri: `${API_URL}/graphql` });

// Subscriptions (a live board) go over a socket on the same path. Same origin
// is the page's own host; a named API swaps http for ws.
function socketUrl(): string | null {
  const base = API_URL || (Platform.OS === 'web' ? window.location.origin : '');
  return base ? `${base.replace(/^http/, 'ws')}/graphql` : null;
}

let connectedBefore = false;

// Lazy: the socket opens with the first subscription and closes after the
// last, so a screen that watches nothing holds nothing open. A browser cannot
// put headers on a socket, so the token rides in the connection's params, read
// afresh on every connect so a new sign-in is the one that counts.
const wsUrl = socketUrl();
const wsLink = wsUrl
  ? new GraphQLWsLink(
      createClient({
        url: wsUrl,
        connectionParams: () => {
          const token = getToken();
          return token ? { authorization: `Bearer ${token}` } : {};
        },
        retryAttempts: Number.POSITIVE_INFINITY,
        on: {
          // Changes made while the socket was down were never announced, so a
          // reconnect refetches what is on screen rather than trusting it.
          connected: () => {
            if (connectedBefore) void client.refetchQueries({ include: 'active' });
            connectedBefore = true;
          },
        },
      }),
    )
  : null;

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
        drafts: replace,
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
    wsLink
      ? split(
          ({ query }) => {
            const definition = getMainDefinition(query);
            return definition.kind === 'OperationDefinition' && definition.operation === 'subscription';
          },
          wsLink,
          from([authLink, httpLink]),
        )
      : from([authLink, httpLink]),
  ]),
});
