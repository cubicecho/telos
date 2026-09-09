import { Platform } from 'react-native';

// The session token lives in localStorage rather than a cookie: the API is a
// Bearer-token GraphQL endpoint with no session table, and the client is a
// static bundle that may be served from a different origin in development.
const TOKEN_KEY = 'telos_token';

export function getToken(): string | null {
  if (Platform.OS === 'web') return window.localStorage.getItem(TOKEN_KEY);
  return null;
}

export function setToken(token: string): void {
  if (Platform.OS === 'web') window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (Platform.OS === 'web') window.localStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return getToken() !== null;
}
