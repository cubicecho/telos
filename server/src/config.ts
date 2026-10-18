import { randomBytes } from 'node:crypto';
import { AUTH_DEFAULTS } from './defaults.ts';

/** Truthy env-var values: "1", "true", "yes" (case-insensitive). */
export function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
}

/** Falsy env-var values: "0", "false", "no" (case-insensitive). */
function envDisabled(value: string | undefined): boolean {
  return ['0', 'false', 'no'].includes((value ?? '').trim().toLowerCase());
}

/** What signs sessions when `BETTER_AUTH_SECRET` is unset. preflight.ts refuses it in production. */
export const DEV_SECRET = 'dev-secret-change-in-production';

/** The value `.env.example` ships. Public, so as good as no secret at all. */
export const PLACEHOLDER_SECRET = 'change-me-to-a-long-random-string';

/**
 * Why `secret` must not sign production tokens, or undefined when it may.
 *
 * better-auth signs with this and nothing else, so a secret that is published
 * or short enough to guess lets anyone forge what it signs.
 *
 * @param secret - `BETTER_AUTH_SECRET` as set.
 * @returns The reason, as the end of a sentence ("is not set").
 */
export function describeWeakSecret(secret: string | undefined): string | undefined {
  if (secret === undefined || secret === '') return 'is not set';
  if (secret === DEV_SECRET || secret === PLACEHOLDER_SECRET) return 'is a published default';
  if (secret.length < AUTH_DEFAULTS.minSecretLength) {
    return `is shorter than ${AUTH_DEFAULTS.minSecretLength} characters`;
  }
  return undefined;
}

/**
 * The secret as configured, for preflight to judge.
 *
 * @returns `BETTER_AUTH_SECRET`, or undefined when unset.
 */
export function configuredAuthSecret(): string | undefined {
  return process.env.BETTER_AUTH_SECRET;
}

/**
 * What better-auth signs with. Read at call time so a test sees the current environment.
 *
 * @returns `BETTER_AUTH_SECRET`, or the development secret when unset.
 */
export function authSecret(): string {
  return configuredAuthSecret() || DEV_SECRET;
}

/**
 * Whether typing an address signs in, with no link. The network is then the
 * whole credential: anyone who can reach the port can sign in as anyone. For a
 * self-hosted instance on a private network, and nothing else; preflight.ts
 * refuses it when APP_URL names a public host.
 *
 * @returns `SECURE_LOCAL_NET` as a flag, off when unset.
 */
export function secureLocalNet(): boolean {
  return envFlag(process.env.SECURE_LOCAL_NET);
}

/**
 * Whether SECURE_LOCAL_NET may be on with a public APP_URL: the operator's word
 * that nothing hostile can reach the port anyway.
 *
 * @returns `I_KNOW_SECURE_LOCAL_NET_IS_PUBLIC` as a flag, off when unset.
 */
export function allowsPublicLocalNet(): boolean {
  return envFlag(process.env.I_KNOW_SECURE_LOCAL_NET_IS_PUBLIC);
}

/**
 * Where sign-in email is sent through: a nodemailer connection URL
 * (`smtp://user:pass@mail.example.com:587`).
 *
 * @returns `SMTP_URL`, or an empty string when unset.
 */
export function smtpUrl(): string {
  return process.env.SMTP_URL?.trim() ?? '';
}

/**
 * The address sign-in email comes from.
 *
 * @returns `SMTP_FROM`, or `telos@` the host of `APP_URL`.
 */
export function smtpFrom(): string {
  return process.env.SMTP_FROM?.trim() || `telos@${new URL(appUrl()).hostname}`;
}

/**
 * Whether sign-in links can be emailed. Without it, the instance sends no links
 * at all, and people sign in through an OIDC provider or SECURE_LOCAL_NET.
 *
 * @returns true when `SMTP_URL` is set.
 */
export function smtpConfigured(): boolean {
  return smtpUrl() !== '';
}

/**
 * Express `trust proxy`: which hops may set X-Forwarded-For, and so what
 * `req.ip` is. Sign-in is throttled per client address, so behind a proxy this
 * must say so, or every visitor shares the proxy's budget. Never `true` on a
 * port the internet reaches directly: a client could then pick its own address.
 *
 * @returns false when `TRUST_PROXY` is unset or "false", a hop count for digits, otherwise the value as given.
 */
export function trustProxy(): boolean | number | string {
  const raw = (process.env.TRUST_PROXY ?? '').trim();
  if (raw === '' || raw === 'false') return false;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/**
 * Where magic links point. In production the server serves the client itself,
 * so its own origin is the right default, but only for someone browsing from
 * this machine. Set APP_URL to the address users actually type; a link to
 * `localhost` is useless in an inbox.
 */
export function appUrl(): string {
  return process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
}

/**
 * A page of the app as a full URL, for a link that leaves it: an email, or a
 * todo's `url` handed to another app. A trailing slash on APP_URL is dropped
 * so the path does not start with two.
 */
export function appLink(path: string): string {
  return `${appUrl().replace(/\/+$/, '')}${path}`;
}

/**
 * Where a browser reaches this server: the OIDC sign-in's start and callback
 * live here. In production one server serves both the API and the app, so it is
 * APP_URL. In development the Expo dev server is the app and this is the API,
 * on a port of its own.
 *
 * @returns `SERVER_URL`, `APP_URL` in production, or this server's own localhost address.
 */
export function serverUrl(): string {
  const configured = process.env.SERVER_URL?.trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') return appUrl().replace(/\/+$/, '');
  return `http://localhost:${process.env.PORT ?? 3001}`;
}

/**
 * Whether this server offers AI at all, which it does unless `AI_ENABLED` is
 * false. Offered, an admin turns it on or off in Settings (instance.ts), and it
 * starts off. With `AI_ENABLED=false` the AI surface does not exist: no `/mcp`,
 * no API keys, no AI fields in the schema, and no switch to flip.
 */
export function aiAvailable(): boolean {
  return !envDisabled(process.env.AI_ENABLED);
}

/**
 * The runner's key, which the runner sends as `x-runner-key` to act as the
 * system principal (resolvers/runs.ts). The server runs its own runner and
 * hands it this key, so by default it is made up at boot and never leaves the
 * process. Set `RUNNER_KEY` only to let a runner on another host in as well.
 */
export const runnerKey: () => string = (() => {
  const key = process.env.RUNNER_KEY?.trim() || randomBytes(32).toString('hex');
  return () => key;
})();

/** The provider id the OIDC provider is registered under, and so its callback path. */
export const OIDC_PROVIDER_ID = 'oidc';

/** The `OIDC_CLIENT_AUTH` values a provider can expect. */
export const OIDC_CLIENT_AUTH_METHODS = ['client_secret_basic', 'client_secret_post'] as const;

/** An OpenID Connect provider to sign in with (heautou, Keycloak, Authentik, …). */
export interface OidcConfig {
  /** The issuer URL. Its discovery document is at `/.well-known/openid-configuration` under it. */
  issuer: string;
  clientId: string;
  /** Unset for a public client, which proves itself with PKCE alone. */
  clientSecret: string | undefined;
  /** How a confidential client sends its secret. The provider must expect the same. */
  clientAuth: (typeof OIDC_CLIENT_AUTH_METHODS)[number];
  /** What the login page's button calls it. */
  name: string;
}

/**
 * The OIDC provider, when `OIDC_ISSUER` and `OIDC_CLIENT_ID` are both set.
 * preflight.ts refuses one without the other.
 */
export function oidcConfig(): OidcConfig | null {
  const issuer = process.env.OIDC_ISSUER?.trim();
  const clientId = process.env.OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return null;
  return {
    issuer: issuer.replace(/\/+$/, ''),
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET?.trim() || undefined,
    clientAuth:
      process.env.OIDC_CLIENT_AUTH?.trim() === 'client_secret_post'
        ? 'client_secret_post'
        : AUTH_DEFAULTS.oidcClientAuth,
    name: process.env.OIDC_NAME?.trim() || AUTH_DEFAULTS.oidcName,
  };
}

/** The address to register with the provider as the client's redirect URI: better-auth's callback, under `serverUrl()`. */
export function oidcRedirectUri(): string {
  return `${serverUrl()}/api/auth/callback/${OIDC_PROVIDER_ID}`;
}
