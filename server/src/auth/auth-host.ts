import type { DB } from '@telos/db';
import { type OidcConfig, oidcApiAudience } from '../core/config.ts';
import { effectiveOidc } from '../sso/settings.ts';
import { type Auth, createAuth } from './better-auth.ts';
import { createProviderTokens, type ProviderTokens } from './provider-tokens.ts';

// better-auth fixes its plugins when it is created, and the OIDC provider is
// one of them. Pairing or unpairing a provider while the server runs therefore
// means a new instance, and everything that signs people in asks this host for
// the current one on each request instead of holding on to one from boot.

export interface AuthHost {
  /** The auth instance to use for this request. */
  current(): Auth;
  /** The OIDC provider `current()` was built with, or null. */
  oidc(): OidcConfig | null;
  /**
   * What checks that provider's access tokens as bearers, or null with no
   * provider. Built with the instance, so a new pairing never trusts the last
   * provider's keys.
   */
  providerTokens(): ProviderTokens | null;
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
    return { auth: createAuth(db, { oidc: config }), oidc: config, tokens: tokensFor(config) };
  };
  let built = await build();
  return {
    current: () => built.auth,
    oidc: () => built.oidc,
    providerTokens: () => built.tokens,
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
  const tokens = tokensFor(oidc);
  return { current: () => auth, oidc: () => oidc, providerTokens: () => tokens, rebuild };
}

/**
 * The access-token verifier for a provider, against the API audience as it is set now.
 *
 * @param oidc The provider, or null.
 * @returns The verifier, or null with no provider: then no JWT is a bearer.
 */
function tokensFor(oidc: OidcConfig | null): ProviderTokens | null {
  return oidc ? createProviderTokens(oidc.issuer, oidcApiAudience()) : null;
}
