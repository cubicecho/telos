// Every tunable value the server uses, as plain data. Nothing here computes, reads
// the environment or imports. A different value is passed as an override where
// the thing is built (a test's tighter limiter), never by editing a group at
// runtime: each group is frozen.

/** The sign-in throttle (rate-limit.ts). */
export interface RateLimitSettings {
  /** Attempts allowed per key inside one window. */
  maxAttempts: number;
  /** How long an attempt counts against its key. */
  windowMinutes: number;
  /** Past this many keys, a hit sweeps out the ones whose window has passed. */
  sweepAtKeys: number;
}

export const RATE_LIMIT_DEFAULTS: Readonly<RateLimitSettings> = Object.freeze({
  maxAttempts: 5,
  windowMinutes: 15,
  sweepAtKeys: 10_000,
});

/** Sign-in and credential settings. */
export interface AuthSettings {
  /** How long a session lasts after it was last used. Long: there is no password to fall back on. */
  sessionTtlDays: number;
  /** How long an emailed sign-in link works. Short: it travels by mail. */
  magicLinkTtlMinutes: number;
  /** The shortest `BETTER_AUTH_SECRET` production accepts. `openssl rand -hex 32` gives twice this. */
  minSecretLength: number;
  /** How long the token an OIDC callback hands the app works: the hop from the callback to `/auth/sso`. */
  oneTimeTokenTtlMinutes: number;
  /** What the login page's OIDC button calls the provider. `OIDC_NAME` overrides it. */
  oidcName: string;
  /** How a confidential OIDC client sends its secret. `OIDC_CLIENT_AUTH` overrides it. */
  oidcClientAuth: 'client_secret_basic' | 'client_secret_post';
  /** How long pairing waits on the provider before calling it unreachable. */
  oidcPairingTimeoutMs: number;
  /**
   * How long the answer to "has the provider turned the paired device client's device flow on?" is kept before
   * asking again. `authConfig` is read signed out, so this bounds how often that asks the provider.
   */
  deviceClientCheckSeconds: number;
  /** How far a provider access token's `exp`, `iat` and `nbf` may be off from this server's clock. */
  providerTokenClockToleranceSeconds: number;
  /** How long fetching the provider's discovery document or keys may take before a token is refused. */
  providerTokenFetchTimeoutMs: number;
}

export const AUTH_DEFAULTS: Readonly<AuthSettings> = Object.freeze({
  sessionTtlDays: 30,
  magicLinkTtlMinutes: 15,
  minSecretLength: 32,
  oneTimeTokenTtlMinutes: 3,
  oidcName: 'SSO',
  // The default the OIDC spec names.
  oidcClientAuth: 'client_secret_basic',
  oidcPairingTimeoutMs: 10_000,
  deviceClientCheckSeconds: 60,
  providerTokenClockToleranceSeconds: 30,
  providerTokenFetchTimeoutMs: 5000,
});

/** Settings for the HTTP doors and the process behind them. */
export interface HttpSettings {
  /** Largest JSON body /graphql and /mcp accept, as `express.json` reads it. Real operations are a few kB. */
  bodyLimit: string;
  /** How long shutdown lets open requests finish before it cuts them, live boards included. */
  drainSeconds: number;
  /** How long shutdown may take in all before a hard exit. Keep it under Docker's 10 s stop grace period. */
  shutdownDeadlineSeconds: number;
}

export const HTTP_DEFAULTS: Readonly<HttpSettings> = Object.freeze({
  bodyLimit: '1mb',
  drainSeconds: 5,
  shutdownDeadlineSeconds: 8,
});
