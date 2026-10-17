import type { DB } from '@telos/db';
import { type Auth, createAuth } from './auth.ts';
import type { OidcConfig } from './config.ts';
import { effectiveOidc } from './oidc-settings.ts';

// better-auth fixes its plugins when it is created, and the OIDC provider is
// one of them. Pairing or unpairing a provider while the server runs therefore
// means a new instance, and everything that signs people in asks this host for
// the current one on each request instead of holding on to one from boot.

export interface AuthHost {
  /** The auth instance to use for this request. */
  current(): Auth;
  /** The OIDC provider `current()` was built with, or null. */
  oidc(): OidcConfig | null;
  /** Builds a new instance from the provider in use now (oidc-settings.ts). */
  rebuild(): Promise<void>;
}

/**
 * A host built from the environment and the database's pairing.
 *
 * @param db The database.
 * @returns The host, with its first instance built.
 */
export async function createAuthHost(db: DB): Promise<AuthHost> {
  const build = async () => {
    const { config } = await effectiveOidc(db);
    return { auth: createAuth(db, { oidc: config }), oidc: config };
  };
  let built = await build();
  return {
    current: () => built.auth,
    oidc: () => built.oidc,
    async rebuild() {
      built = await build();
    },
  };
}

/**
 * A host that never changes, for a caller that already has its instance.
 *
 * @param auth The instance.
 * @param oidc The provider it was built with.
 * @param rebuild What to do when asked to rebuild. Nothing, by default.
 * @returns The host.
 */
export function fixedAuthHost(auth: Auth, oidc: OidcConfig | null, rebuild = async () => {}): AuthHost {
  return { current: () => auth, oidc: () => oidc, rebuild };
}
