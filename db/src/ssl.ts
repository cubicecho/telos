/**
 * Whether a host is this machine or on a private network.
 *
 * "Private" is wider than loopback, because self-hosting is: a compose service
 * and a box on the LAN are both names nothing outside can reach.
 *
 * @param hostname - The host from a URL, lowercased and without IPv6 brackets.
 * @returns true for localhost, a dotless name or a private address.
 */
export function isPrivateHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  // A name with no dots is a container or LAN hostname, not a public address.
  if (!hostname.includes('.') && !hostname.includes(':')) return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 127) return true; // loopback
    if (a === 10) return true; // 10/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 169 && b === 254) return true; // link-local
    return false;
  }

  // Loopback, unique-local fc00::/7, then link-local fe80::/10.
  return hostname === '::1' || /^f[cd]/.test(hostname) || /^fe[89ab]/.test(hostname);
}

/**
 * Whether to insist on TLS for a connection string.
 *
 * Read from the parsed hostname, never the raw string: a URL carrying
 * credentials (`postgres://user:pass@postgres:5432/db`) puts the userinfo where
 * a naive prefix match looks for the host.
 *
 * "Local" is wider than loopback here, because self-hosting is. A bare
 * `postgres` is a service on a compose network; `10.0.0.5` is a box on the
 * LAN — neither speaks TLS by default, and demanding it just breaks the
 * connection. Only an address that could route off a private network gets TLS
 * forced on it.
 */
export function requiresSsl(url: string): boolean {
  // An explicit sslmode is the operator's decision; postgres-js reads it itself.
  if (/[?&]sslmode=/i.test(url)) return false;

  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }

  return isPrivateHost(hostname) === false;
}
