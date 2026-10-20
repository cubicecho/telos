import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// The OIDC provider this instance was paired with (server/src/sso/pairing.ts):
// one row or none, owned by no user, written only by the server. OIDC_ISSUER in
// the environment wins over it. The secret and the registration access token
// are credentials; nothing reads them back out through the API.
export const oidcSettings = pgTable(
  'oidc_settings',
  {
    id: text('id').primaryKey().default('oidc'),
    issuer: text('issuer').notNull(),
    clientId: text('client_id').notNull(),
    clientSecret: text('client_secret'),
    // How the secret is sent to the token endpoint.
    clientAuth: text('client_auth').notNull().default('client_secret_basic'),
    // What the login page's button calls the provider.
    name: text('name').notNull(),
    // RFC 7592: what updates or deletes the registration at the provider.
    registrationAccessToken: text('registration_access_token'),
    registrationClientUri: text('registration_client_uri'),
    // The public client registered beside it for device apps (Home Assistant)
    // to use the device flow with, and what reads or deletes it (RFC 7592).
    // Null when the provider registered none.
    deviceClientId: text('device_client_id'),
    deviceRegistrationAccessToken: text('device_registration_access_token'),
    deviceRegistrationClientUri: text('device_registration_client_uri'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check('oidc_settings_singleton', sql`${t.id} = 'oidc'`)],
);

export type OidcSettings = typeof oidcSettings.$inferSelect;
