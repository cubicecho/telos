import type { Express, Request, Response } from 'express';
import { type Auth, toHeaders } from '../auth.ts';
import type { AuthHost } from '../auth-host.ts';
import { appLink, appUrl, OIDC_PROVIDER_ID } from '../config.ts';

// The two legs of an OIDC sign-in that cannot be GraphQL, because the browser
// has to be sent somewhere: out to the provider, and back from it. Both are
// better-auth's own endpoints (`signInSocial` and `/callback/:id`); this file
// only carries them over HTTP and changes how the session reaches the app.
//
// better-auth would end the callback by setting a session cookie. Telos keeps
// its session as a bearer token in the app instead, so the cookie is dropped
// and the browser lands on /auth/sso with a one-time token, which the app
// swaps for the session over GraphQL (`verifyOneTimeToken`).

/** Where the login page's button sends the browser. */
export const SSO_START_PATH = `/sso/${OIDC_PROVIDER_ID}`;

/** Where better-auth's callback lands the browser, signed in or not. */
const SIGNED_IN_PATH = '/auth/sso';
const FAILED_PATH = '/login';

/**
 * Mounts the start and callback routes. They are always there, because a
 * provider can be paired while the server runs; each asks the host for the
 * current auth instance, and with no provider sends the browser back to the
 * login page.
 *
 * @param app The Express app.
 * @param host Where the current auth instance is.
 */
export function mountSso(app: Express, host: AuthHost): void {
  app.get(SSO_START_PATH, (req, res) => {
    if (!host.oidc()) return off(res);
    void start(host.current(), req, res).catch((error: unknown) => fail(res, 'sign_in_failed', error));
  });
  app.get(`/api/auth/callback/${OIDC_PROVIDER_ID}`, (req, res) => {
    if (!host.oidc()) return off(res);
    void callback(host.current(), req, res).catch((error: unknown) => fail(res, 'callback_failed', error));
  });
}

/**
 * Starts a sign-in: better-auth makes the state (kept in the database, with a
 * signed cookie that ties it to this browser), the PKCE verifier and the
 * nonce, and says where the provider's authorize page is.
 */
async function start(auth: Auth, req: Request, res: Response): Promise<void> {
  const { headers, response } = await auth.api.signInSocial({
    body: {
      provider: OIDC_PROVIDER_ID,
      callbackURL: appLink(SIGNED_IN_PATH),
      errorCallbackURL: appLink(FAILED_PATH),
      disableRedirect: true,
    },
    headers: toHeaders(req.headers),
    returnHeaders: true,
  });
  const url = response && 'url' in response ? response.url : undefined;
  if (!url) throw new Error('better-auth returned no authorize URL');
  for (const cookie of headers?.getSetCookie() ?? []) res.append('set-cookie', cookie);
  res.redirect(302, url);
}

/**
 * The provider's redirect back. better-auth checks the state, swaps the code,
 * verifies the id token and opens a session; this then swaps the session
 * cookie it would have set for a one-time token on the app's URL.
 */
async function callback(auth: Auth, req: Request, res: Response): Promise<void> {
  const request = new Request(new URL(req.originalUrl, appUrl()), {
    method: 'GET',
    headers: toHeaders(req.headers),
  });
  const response = await auth.handler(request);
  const ctx = await auth.$context;
  const sessionCookies = new Set([ctx.authCookies.sessionToken.name, ctx.authCookies.sessionData.name]);

  // The state cookie's expiry, and anything else that is not the session.
  for (const cookie of response.headers.getSetCookie()) {
    const name = cookie.slice(0, cookie.indexOf('='));
    if (!sessionCookies.has(name)) res.append('set-cookie', cookie);
  }

  let location = response.headers.get('location');
  if (!location) {
    fail(res, 'callback_failed', new Error(`better-auth's callback answered ${response.status} with no redirect`));
    return;
  }

  // Set by the bearer plugin whenever a session cookie is: the new session.
  const session = response.headers.get('set-auth-token');
  if (session) {
    const { token } = await auth.api.generateOneTimeToken({
      headers: new Headers({ authorization: `Bearer ${session}` }),
    });
    const target = new URL(location, appUrl());
    target.searchParams.set('token', token);
    location = target.toString();
  }
  res.redirect(302, location);
}

/** Back to the login page, which says there is no provider to sign in with. */
function off(res: Response): void {
  res.redirect(302, `${appLink(FAILED_PATH)}?error=sso_off`);
}

/** Back to the login page, which says that signing in failed. */
function fail(res: Response, code: string, error: unknown): void {
  console.error(`[auth] OIDC ${code}:`, error);
  if (res.headersSent) return;
  res.redirect(302, `${appLink(FAILED_PATH)}?error=${encodeURIComponent(code)}`);
}
