import type { DB } from '@telos/db';
import * as dbSchema from '@telos/db/schema';
import { type OidcConfig, oidcConfig } from '../core/config.ts';
import type { SsoSource } from '../core/enums.ts';

// The OIDC provider the instance signs in with, from one of two places: the
// environment (OIDC_ISSUER), or a pairing an admin made by pasting a setup URL
// (sso/pairing.ts), kept in the `oidc_settings` row. The environment wins, so
// a deployment that pins its provider cannot be re-paired from the app.

/** Where the provider in use came from. */
export type OidcSource = SsoSource;

/** The `oidc_settings` row, as pairing writes it. */
export interface PairedOidc {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
  clientAuth: OidcConfig['clientAuth'];
  name: string;
  registrationAccessToken: string | null;
  registrationClientUri: string | null;
  /** The public client for device apps, registered beside it. Null when the provider registered none. */
  deviceClientId: string | null;
  deviceRegistrationAccessToken: string | null;
  deviceRegistrationClientUri: string | null;
}

/**
 * The paired provider, if there is one.
 *
 * @param db The database.
 * @returns The row, or null.
 */
export async function readPairedOidc(db: DB): Promise<PairedOidc | null> {
  const [row] = await db.select().from(dbSchema.oidcSettings).limit(1);
  if (!row) return null;
  return {
    issuer: row.issuer,
    clientId: row.clientId,
    clientSecret: row.clientSecret,
    clientAuth: row.clientAuth === 'client_secret_post' ? 'client_secret_post' : 'client_secret_basic',
    name: row.name,
    registrationAccessToken: row.registrationAccessToken,
    registrationClientUri: row.registrationClientUri,
    deviceClientId: row.deviceClientId,
    deviceRegistrationAccessToken: row.deviceRegistrationAccessToken,
    deviceRegistrationClientUri: row.deviceRegistrationClientUri,
  };
}

/**
 * Saves a pairing, replacing any before it.
 *
 * @param db The database.
 * @param paired What the provider registered.
 */
export async function savePairedOidc(db: DB, paired: PairedOidc): Promise<void> {
  const values = { ...paired, updatedAt: new Date() };
  await db
    .insert(dbSchema.oidcSettings)
    .values(values)
    .onConflictDoUpdate({ target: dbSchema.oidcSettings.id, set: values });
}

/**
 * Forgets the pairing.
 *
 * @param db The database.
 */
export async function clearPairedOidc(db: DB): Promise<void> {
  await db.delete(dbSchema.oidcSettings);
}

/**
 * The provider sign-in uses, and where it came from: the environment when
 * OIDC_ISSUER is set, otherwise the pairing.
 *
 * @param db The database.
 * @returns The config (null when there is none) and its source.
 */
export async function effectiveOidc(db: DB): Promise<{ config: OidcConfig | null; source: OidcSource }> {
  const env = oidcConfig();
  if (env) return { config: env, source: 'env' };
  const paired = await readPairedOidc(db);
  if (!paired) return { config: null, source: 'none' };
  return {
    config: {
      issuer: paired.issuer,
      clientId: paired.clientId,
      clientSecret: paired.clientSecret ?? undefined,
      clientAuth: paired.clientAuth,
      name: paired.name,
    },
    source: 'paired',
  };
}
