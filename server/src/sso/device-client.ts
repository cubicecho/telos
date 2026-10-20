import type { DB } from '@telos/db';
import { oidcDeviceClientId } from '../core/config.ts';
import { AUTH_DEFAULTS } from '../core/defaults.ts';
import { effectiveOidc, readPairedOidc } from './settings.ts';

// Which public client a device app (Home Assistant) should use at the provider
// for the device flow. OIDC_DEVICE_CLIENT_ID wins. Otherwise it is the device
// client pairing registered, but only once the provider lets it use the device
// flow: heautou holds it back until its admin turns it on, and removes the
// client when they turn it off. Telos reads its registration (RFC 7592) to see
// which, and remembers the answer for AUTH_DEFAULTS.deviceClientCheckSeconds,
// because `authConfig` is read signed out.

/** The device code grant (RFC 8628). */
export const DEVICE_CODE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

interface Checked {
  /** The registration the answer is about. */
  uri: string;
  hasDeviceFlow: boolean;
  /** When to ask again, in epoch milliseconds. */
  until: number;
}

let checked: Checked | null = null;

/**
 * Asks the provider whether the device client has the device flow now.
 *
 * @param uri Its registration client URI.
 * @param token Its registration access token.
 * @returns True when its registration lists the device code grant. False when
 *   it does not, the client is gone, or the provider can't be reached.
 */
async function hasDeviceFlow(uri: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(uri, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(AUTH_DEFAULTS.oidcPairingTimeoutMs),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    const grants = body && typeof body === 'object' ? (body as { grant_types?: unknown }).grant_types : undefined;
    return Array.isArray(grants) && grants.includes(DEVICE_CODE_GRANT);
  } catch {
    return false;
  }
}

/**
 * The device client to tell device apps about.
 *
 * @param db The database.
 * @param now The clock, in epoch milliseconds.
 * @returns `OIDC_DEVICE_CLIENT_ID`, else the paired device client while it has
 *   the device flow, else null.
 */
export async function deviceClientId(db: DB, now = Date.now()): Promise<string | null> {
  const fromEnv = oidcDeviceClientId();
  if (fromEnv) return fromEnv;
  const { source } = await effectiveOidc(db);
  if (source !== 'paired') return null;
  const paired = await readPairedOidc(db);
  const uri = paired?.deviceRegistrationClientUri;
  const token = paired?.deviceRegistrationAccessToken;
  if (!paired?.deviceClientId || !uri || !token) return null;
  if (checked === null || checked.uri !== uri || checked.until <= now) {
    checked = {
      uri,
      hasDeviceFlow: await hasDeviceFlow(uri, token),
      until: now + AUTH_DEFAULTS.deviceClientCheckSeconds * 1000,
    };
  }
  return checked.hasDeviceFlow ? paired.deviceClientId : null;
}

/** Forgets the remembered answer, so the next read asks the provider. For tests, and after pairing changes. */
export function forgetDeviceClientCheck(): void {
  checked = null;
}
