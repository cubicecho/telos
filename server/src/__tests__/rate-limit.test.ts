import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_DEFAULTS } from '../defaults.ts';
import { createRateLimiter } from '../rate-limit.ts';

const MINUTE_MS = 60 * 1000;

describe('createRateLimiter', () => {
  it('lets a key through again once its window has passed', () => {
    let clock = 0;
    const limiter = createRateLimiter({ maxAttempts: 1, windowMinutes: 1 }, () => clock);
    limiter.hit('k');
    expect(() => limiter.hit('k')).toThrow(
      expect.objectContaining({ extensions: { code: 'TOO_MANY_REQUESTS', retryAfter: 60 } }),
    );
    clock = MINUTE_MS + 1;
    expect(() => limiter.hit('k')).not.toThrow();
  });

  it('records nothing for a refused attempt, so retrying does not extend the wait', () => {
    let clock = 0;
    const limiter = createRateLimiter({ maxAttempts: 1, windowMinutes: 1 }, () => clock);
    limiter.hit('k');
    clock = MINUTE_MS / 2;
    expect(() => limiter.hit('k')).toThrow();
    clock = MINUTE_MS + 1;
    expect(() => limiter.hit('k')).not.toThrow();
  });

  it('refuses when any one of the keys is spent', () => {
    const limiter = createRateLimiter({ maxAttempts: 1 }, () => 0);
    limiter.hit('ip:a', 'email:x');
    expect(() => limiter.hit('ip:b', 'email:x')).toThrow();
    expect(() => limiter.hit('ip:c', 'email:y')).not.toThrow();
  });

  it('keeps the default for a setting the overrides leave out', () => {
    const limiter = createRateLimiter({ windowMinutes: 1 }, () => 0);
    for (let attempt = 0; attempt < RATE_LIMIT_DEFAULTS.maxAttempts; attempt += 1) limiter.hit('k');
    expect(() => limiter.hit('k')).toThrow();
  });
});
