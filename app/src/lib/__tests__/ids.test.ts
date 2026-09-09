import { afterEach, describe, expect, it, vi } from 'vitest';
import { newId } from '../ids';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Bound before any stub replaces the global, or the stub calls itself.
const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);

/** Hide `crypto.randomUUID` the way an insecure context does, leaving the rest of `crypto`. */
function withoutRandomUUID(): void {
  vi.stubGlobal('crypto', { getRandomValues });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('newId', () => {
  it('returns a v4 UUID', () => {
    expect(newId()).toMatch(UUID_V4);
  });

  it('returns a v4 UUID with no crypto.randomUUID, which is how an http origin looks', () => {
    withoutRandomUUID();
    expect(globalThis.crypto.randomUUID).toBeUndefined();
    expect(newId()).toMatch(UUID_V4);
  });

  it('does not repeat itself, on either path', () => {
    const ids = new Set(Array.from({ length: 500 }, newId));
    withoutRandomUUID();
    for (let i = 0; i < 500; i++) ids.add(newId());
    expect(ids.size).toBe(1000);
  });
});
