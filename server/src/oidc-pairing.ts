import type { DB } from '@telos/db';
import { oidcRedirectUri } from './config.ts';
import { clearPairedOidc, type PairedOidc, readPairedOidc, savePairedOidc } from './oidc-settings.ts';

// Pairing with an OIDC provider by pasting one URL, instead of copying a client
// id and secret into the environment. The provider (heautou, or any other that
// does OAuth 2.0 Dynamic Client Registration) hands an admin a setup URL:
//
//   <issuer>#setup=<initial access token>&name=<what to call it>
//
// Telos reads the issuer's discovery document, registers itself at its
// registration endpoint with the token (RFC 7591), and keeps the client it gets
// back. Unpairing deletes that client at the provider (RFC 7592).
//
// The token is a credential: it is sent once, to the endpoint the issuer names,
// and never logged or stored.

/** Why pairing failed, for the app to say what to do next. */
export type PairingFailure =
  /** The text is not a setup URL. */
  | 'BAD_URL'
  /** Nothing at the URL answers as an OIDC provider, or it names a different issuer. */
  | 'NOT_A_PROVIDER'
  /** The provider has no registration endpoint. */
  | 'NO_REGISTRATION'
  /** The setup URL has expired, was used already, or was cancelled. */
  | 'EXPIRED'
  /** The provider would not register Telos as described. */
  | 'REFUSED'
  /** The provider is turning requests away for now. */
  | 'RATE_LIMITED';

export class PairingError extends Error {
  readonly reason: PairingFailure;

  constructor(reason: PairingFailure, message: string) {
    super(message);
    this.name = 'PairingError';
    this.reason = reason;
  }
}

/** A setup URL, taken apart. */
export interface SetupUrl {
  issuer: string;
  token: string;
  name: string;
}

/** What the button calls a provider whose setup URL names none. */
const DEFAULT_NAME = 'SSO';

/** How long to wait on the provider before calling it unreachable. */
const TIMEOUT_MS = 10_000;

/**
 * Takes a setup URL apart.
 *
 * @param text What was pasted.
 * @returns The issuer, the initial access token and the provider's name.
 */
export function parseSetupUrl(text: string): SetupUrl {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new PairingError('BAD_URL', 'That is not a URL. Paste the setup URL your provider gave you.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new PairingError('BAD_URL', 'A setup URL starts with https://.');
  }
  const params = new URLSearchParams(url.hash.slice(1));
  const token = params.get('setup');
  if (!token) {
    throw new PairingError('BAD_URL', 'That URL has no setup token. Copy the whole setup URL from your provider.');
  }
  url.hash = '';
  url.search = '';
  return {
    issuer: url.toString().replace(/\/+$/, ''),
    token,
    name: params.get('name')?.trim() || DEFAULT_NAME,
  };
}

/** Fetches with a timeout, calling any network failure the provider being unreachable. */
async function call(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new PairingError('NOT_A_PROVIDER', `Could not reach ${new URL(url).origin}. Check the setup URL.`);
  }
}

/** The body of a JSON response, or an empty object when it has none. */
async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * The issuer's registration endpoint, after checking the discovery document is
 * the issuer's own.
 */
async function discover(issuer: string): Promise<string> {
  const response = await call(`${issuer}/.well-known/openid-configuration`, {
    headers: { accept: 'application/json' },
  });
  const doc = response.ok ? await json(response) : {};
  if (text(doc.issuer)?.replace(/\/+$/, '') !== issuer) {
    throw new PairingError('NOT_A_PROVIDER', `${issuer} is not an OpenID Connect provider. Check the setup URL.`);
  }
  const endpoint = text(doc.registration_endpoint);
  if (!endpoint) {
    throw new PairingError(
      'NO_REGISTRATION',
      'This provider does not support pairing. Set OIDC_ISSUER and OIDC_CLIENT_ID in the environment instead.',
    );
  }
  return endpoint;
}

/** What Telos asks to be registered as. */
function clientMetadata() {
  return {
    client_name: 'Telos',
    redirect_uris: [oidcRedirectUri()],
    token_endpoint_auth_method: 'client_secret_basic',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  };
}

/** Turns a failed registration call into what to tell the admin. */
async function refusal(response: Response): Promise<PairingError> {
  const body = await json(response);
  const description = text(body.error_description) ?? text(body.error);
  if (response.status === 401 || body.error === 'invalid_token') {
    return new PairingError(
      'EXPIRED',
      'This setup URL has expired, was used already, or was cancelled. Ask your provider for a new one.',
    );
  }
  if (response.status === 429) {
    return new PairingError('RATE_LIMITED', 'The provider is turning requests away for now. Try again in a minute.');
  }
  if (response.status === 400) {
    return new PairingError('REFUSED', `The provider refused to register Telos: ${description ?? 'no reason given'}.`);
  }
  return new PairingError('NOT_A_PROVIDER', `The provider answered ${response.status} when asked to register Telos.`);
}

/**
 * Registers Telos with the provider a setup URL names, and keeps the client.
 * The caller rebuilds the auth instance (auth-host.ts) to start using it.
 *
 * @param db The database.
 * @param setupUrl What the admin pasted.
 * @returns The pairing as saved.
 */
export async function pair(db: DB, setupUrl: string): Promise<PairedOidc> {
  const setup = parseSetupUrl(setupUrl);
  const endpoint = await discover(setup.issuer);
  const response = await call(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${setup.token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(clientMetadata()),
  });
  if (!response.ok) throw await refusal(response);
  const body = await json(response);
  const clientId = text(body.client_id);
  if (!clientId) {
    throw new PairingError('NOT_A_PROVIDER', 'The provider registered Telos but sent back no client id.');
  }
  const method = text(body.token_endpoint_auth_method);
  const paired: PairedOidc = {
    issuer: setup.issuer,
    clientId,
    clientSecret: text(body.client_secret),
    clientAuth: method === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic',
    name: setup.name,
    registrationAccessToken: text(body.registration_access_token),
    registrationClientUri: text(body.registration_client_uri),
  };
  await savePairedOidc(db, paired);
  return paired;
}

/**
 * Deletes Telos's client at the provider and forgets the pairing. The pairing
 * is forgotten even when the provider cannot be reached, so an admin is never
 * stuck with a provider they want gone; the provider's admin can remove the
 * client on their side.
 *
 * @param db The database.
 * @returns Whether the provider confirmed the client is gone.
 */
export async function unpair(db: DB): Promise<boolean> {
  const paired = await readPairedOidc(db);
  if (!paired) return true;
  let removed = false;
  if (paired.registrationClientUri && paired.registrationAccessToken) {
    try {
      const response = await fetch(paired.registrationClientUri, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${paired.registrationAccessToken}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      // A 401 or 404: the client is already gone, which is what was wanted.
      removed = response.ok || response.status === 401 || response.status === 404;
      if (!removed) console.warn(`[auth] OIDC provider answered ${response.status} to deleting the client`);
    } catch (error) {
      console.warn('[auth] Could not reach the OIDC provider to delete the client:', error);
    }
  }
  await clearPairedOidc(db);
  return removed;
}
