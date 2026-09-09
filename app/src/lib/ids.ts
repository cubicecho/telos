/**
 * A v4 UUID, generated here rather than by Postgres.
 *
 * A row's id has to exist before the row does. An optimistic list entry that
 * later swapped id would remount when the server answered, and anything the
 * user did to it in the meantime — ticking it off, attaching a label — would
 * name an id the server had never heard of.
 *
 * `crypto.randomUUID` is the obvious way to get one and is not always there:
 * it is restricted to secure contexts, and Telos is meant to be run on a LAN
 * over plain http, where it is undefined. `crypto.getRandomValues` carries no
 * such restriction, so the fallback assembles a v4 by hand rather than
 * reaching for `Math.random`.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1, the RFC 4122 layout
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
