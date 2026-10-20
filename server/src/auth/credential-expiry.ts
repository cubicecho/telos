import type { Actor } from '../core/context.ts';

// A stream outlives the request that opened it, so the credential it was
// opened with can run out while it is open. A session is long-lived and is
// left alone, as it always was. A provider access token lives minutes, and a
// stream opened with one is ended when it expires, so the client comes back
// with a fresh token rather than listening on a stale one.

/** What a stream yields in place of an event when its credential has expired. */
export const CREDENTIAL_EXPIRED: unique symbol = Symbol('credential expired');

/** The longest `setTimeout` accepts; anything longer fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Ends a stream when the actor's credential expires: it yields
 * `CREDENTIAL_EXPIRED` once, which the subscription's `resolve` answers as
 * UNAUTHENTICATED, and then completes. An actor with no expiry (a session)
 * gets the stream as it was.
 *
 * @param actor The caller the stream was opened for.
 * @param source The stream.
 * @param now The clock. Tests pass their own.
 * @returns The stream, bounded by the credential.
 */
export function untilCredentialExpires<T>(
  actor: Actor,
  source: AsyncIterableIterator<T>,
  now: () => number = Date.now,
): AsyncIterableIterator<T | typeof CREDENTIAL_EXPIRED> {
  const { expiresAt } = actor;
  if (!expiresAt) return source;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<'expired'>((resolve) => {
    timer = setTimeout(() => resolve('expired'), Math.min(Math.max(0, expiresAt.getTime() - now()), MAX_TIMER_MS));
  });
  let state: 'open' | 'expiring' | 'done' = 'open';

  const finish = async (): Promise<IteratorResult<T>> => {
    state = 'done';
    clearTimeout(timer);
    await source.return?.();
    return { value: undefined, done: true };
  };

  const iterator: AsyncIterableIterator<T | typeof CREDENTIAL_EXPIRED> = {
    async next() {
      if (state === 'expiring') return finish();
      if (state === 'done') return { value: undefined, done: true };
      const result = await Promise.race([source.next(), expired]);
      if (result === 'expired') {
        state = 'expiring';
        return { value: CREDENTIAL_EXPIRED, done: false };
      }
      if (result.done) {
        state = 'done';
        clearTimeout(timer);
      }
      return result;
    },
    return: finish,
    async throw(error?: unknown) {
      await finish();
      throw error;
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
  return iterator;
}
