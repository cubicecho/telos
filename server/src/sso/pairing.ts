import type { DB } from '@telos/db';
import { oidcRedirectUri, serverUrl } from '../core/config.ts';
import { AUTH_DEFAULTS } from '../core/defaults.ts';
import { DEVICE_CODE_GRANT, forgetDeviceClientCheck } from './device-client.ts';
import { clearPairedOidc, type PairedOidc, readPairedOidc, savePairedOidc } from './settings.ts';

// Pairing with an OIDC provider by pasting one URL, instead of copying a client
// id and secret into the environment. The provider (heautou, or any other that
// does OAuth 2.0 Dynamic Client Registration) hands an admin a setup URL:
//
//   <issuer>#setup=<initial access token>&name=<what to call it>
//
// Telos reads the issuer's discovery document, registers itself at its
// registration endpoint with the token (RFC 7591), and keeps the client it gets
// back. When the provider offers the device flow (RFC 8628), Telos registers a
// second, public client with the same token, for device apps (Home Assistant)
// to sign in with; a provider that allows the token once refuses it, and
// pairing goes on without one. The provider may hold that client's device flow
// back until its admin turns it on (sso/device-client.ts checks). Unpairing
// deletes both clients at the provider (RFC 7592).
//
// Telos also registers its own address as `client_uri`. Under it, Telos
// serves its protected resource metadata (http/protected-resource.ts), where
// heautou finds Telos's API to offer its admin.
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
    name: params.get('name')?.trim() || AUTH_DEFAULTS.oidcName,
  };
}

/** Fetches with a timeout, calling any network failure the provider being unreachable. */
async function call(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(AUTH_DEFAULTS.oidcPairingTimeoutMs) });
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

/** What the discovery document says pairing needs. */
interface Discovered {
  registrationEndpoint: string;
  /** Whether the provider offers the device flow, so a device client is worth asking for. */
  hasDeviceFlow: boolean;
}

/**
 * The issuer's registration endpoint, and whether it offers the device flow,
 * after checking the discovery document is the issuer's own.
 */
async function discover(issuer: string): Promise<Discovered> {
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
  const grants = Array.isArray(doc.grant_types_supported) ? doc.grant_types_supported : null;
  const hasDeviceFlow =
    text(doc.device_authorization_endpoint) !== null && (grants === null || grants.includes(DEVICE_CODE_GRANT));
  return { registrationEndpoint: endpoint, hasDeviceFlow };
}

/** What Telos asks to be registered as. */
function clientMetadata() {
  return {
    client_name: 'Telos',
    client_uri: serverUrl(),
    redirect_uris: [oidcRedirectUri()],
    token_endpoint_auth_method: 'client_secret_basic',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  };
}

/** What Telos asks its device client to be registered as: public, no redirect, the device flow. */
function deviceClientMetadata() {
  return {
    client_name: 'Telos devices',
    client_uri: serverUrl(),
    redirect_uris: [],
    token_endpoint_auth_method: 'none',
    grant_types: [DEVICE_CODE_GRANT, 'refresh_token'],
    response_types: [],
  };
}

/** The device client a provider registered. */
interface DeviceRegistration {
  clientId: string;
  registrationAccessToken: string | null;
  registrationClientUri: string | null;
}

/**
 * Registers the device client with the setup URL's token, after Telos's own
 * client. Never fails the pairing: a provider that allows the token once, or
 * won't hold a device client, just leaves device sign-in to the environment.
 *
 * @param endpoint The registration endpoint.
 * @param token The initial access token.
 * @returns The client, or null when the provider registered none.
 */
async function registerDeviceClient(endpoint: string, token: string): Promise<DeviceRegistration | null> {
  try {
    const response = await call(endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(deviceClientMetadata()),
    });
    if (!response.ok) {
      console.warn(`[auth] The OIDC provider answered ${response.status} to registering a device client`);
      return null;
    }
    const body = await json(response);
    const clientId = text(body.client_id);
    if (!clientId) return null;
    return {
      clientId,
      registrationAccessToken: text(body.registration_access_token),
      registrationClientUri: text(body.registration_client_uri),
    };
  } catch {
    console.warn('[auth] Could not register a device client with the OIDC provider');
    return null;
  }
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
  const { registrationEndpoint: endpoint, hasDeviceFlow } = await discover(setup.issuer);
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
  const device = hasDeviceFlow ? await registerDeviceClient(endpoint, setup.token) : null;
  const paired: PairedOidc = {
    issuer: setup.issuer,
    clientId,
    clientSecret: text(body.client_secret),
    clientAuth: method === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic',
    name: setup.name,
    registrationAccessToken: text(body.registration_access_token),
    registrationClientUri: text(body.registration_client_uri),
    deviceClientId: device?.clientId ?? null,
    deviceRegistrationAccessToken: device?.registrationAccessToken ?? null,
    deviceRegistrationClientUri: device?.registrationClientUri ?? null,
  };
  await savePairedOidc(db, paired);
  forgetDeviceClientCheck();
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
  const removed = await deleteClient(paired.registrationClientUri, paired.registrationAccessToken);
  // The device client goes too; whether it did is the provider's admin's to tidy.
  await deleteClient(paired.deviceRegistrationClientUri, paired.deviceRegistrationAccessToken);
  await clearPairedOidc(db);
  forgetDeviceClientCheck();
  return removed;
}

/**
 * Deletes a client at the provider (RFC 7592).
 *
 * @param uri Its registration client URI.
 * @param token Its registration access token.
 * @returns Whether the provider confirmed it is gone. False with no way to ask.
 */
async function deleteClient(uri: string | null, token: string | null): Promise<boolean> {
  if (!uri || !token) return false;
  try {
    const response = await fetch(uri, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(AUTH_DEFAULTS.oidcPairingTimeoutMs),
    });
    // A 401 or 404: the client is already gone, which is what was wanted.
    const removed = response.ok || response.status === 401 || response.status === 404;
    if (!removed) console.warn(`[auth] OIDC provider answered ${response.status} to deleting a client`);
    return removed;
  } catch (error) {
    console.warn('[auth] Could not reach the OIDC provider to delete a client:', error);
    return false;
  }
}
