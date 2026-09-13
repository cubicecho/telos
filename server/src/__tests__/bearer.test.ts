import { describe, expect, it } from 'vitest';
import { extractUserId, signMagicToken, signToken } from '../resolvers/auth.ts';

/** A request as `extractUserId` reads it: one header and nothing else. */
const request = (authorization?: string) => ({ headers: { authorization } });

// Every other server test injects `userId` by hand — `helpers.ts` calls
// `graphql()` directly and never goes through Express — so this is the one
// place the header is actually parsed. It is also the only thing standing
// between a request and someone else's data, which is reason enough to pin it.
describe('extractUserId', () => {
  it('reads the id out of a valid Bearer token', () => {
    expect(extractUserId(request(`Bearer ${signToken('user-1')}`))).toBe('user-1');
  });

  it('answers null for no header at all', () => {
    expect(extractUserId(request())).toBeNull();
    expect(extractUserId(request(''))).toBeNull();
  });

  it('requires the scheme, spelled that way', () => {
    const token = signToken('user-1');
    expect(extractUserId(request(token))).toBeNull();
    // Case-sensitive on purpose rather than by accident: it is what the client
    // sends, and loosening it is a change worth making deliberately.
    expect(extractUserId(request(`bearer ${token}`))).toBeNull();
    expect(extractUserId(request(`Basic ${token}`))).toBeNull();
    // No space means no token, whatever follows.
    expect(extractUserId(request(`Bearer${token}`))).toBeNull();
  });

  it('answers null rather than throwing on a token that is not one', () => {
    expect(extractUserId(request('Bearer '))).toBeNull();
    expect(extractUserId(request('Bearer not-a-jwt'))).toBeNull();
    expect(extractUserId(request('Bearer a.b.c'))).toBeNull();
  });

  it('refuses a token signed with another secret', () => {
    const forged = [
      Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
      Buffer.from(JSON.stringify({ userId: 'somebody-else' })).toString('base64url'),
      'not-a-real-signature',
    ].join('.');
    expect(extractUserId(request(`Bearer ${forged}`))).toBeNull();
  });

  it('refuses a sign-in token where a session token belongs', () => {
    // A magic-link token carries an email and no userId, and is minted from an
    // unauthenticated endpoint. Both are signed with the same secret, so the
    // only thing keeping them apart is that this reads `userId`.
    expect(extractUserId(request(`Bearer ${signMagicToken('someone@example.com')}`))).toBeNull();
  });
});
