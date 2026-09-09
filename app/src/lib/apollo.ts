import { ApolloClient, from, HttpLink, InMemoryCache } from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { onError } from '@apollo/client/link/error';
import { Platform } from 'react-native';
import { clearToken, getToken } from '@/lib/auth';

// Empty by default: in production the client is served from the same origin as
// /graphql, so a relative URL is correct and needs no build-time configuration.
// `npm run dev:app` runs Expo on another port and sets EXPO_PUBLIC_API_URL.
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? '';

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
