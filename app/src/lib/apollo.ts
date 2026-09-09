import { ApolloClient, from, HttpLink, InMemoryCache } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { onError } from '@apollo/client/link/error';
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

export const client = new ApolloClient({
  cache: new InMemoryCache(),
  link: from([errorLink, authLink, httpLink]),
});
