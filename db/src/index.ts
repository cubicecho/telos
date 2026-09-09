import { relations } from './relations.ts';
import * as schema from './schema.ts';

// Telos is Postgres-only. There is no embedded fallback: a missing DATABASE_URL
// is a misconfiguration, and silently writing to a local file instead would hide
// it until the data mattered.
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env and run `npm run db:up` for a local Postgres.');
}

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Whether to insist on TLS for this connection.
 *
 * Read from the parsed hostname, never the raw string: a URL carrying
 * credentials (`postgres://user:pass@postgres:5432/db`) puts the userinfo where
 * a naive prefix match looks for the host, and would classify a container link
 * as a trip across the internet.
 *
 * Loopback and dotless names are not remote — a bare `postgres` or `db` is a
 * service on the same private network, and Postgres there is usually plaintext.
 * Everything else in production is assumed to be somewhere a network can see.
 */
function requiresSsl(url: string): boolean {
  // An explicit sslmode is the operator's decision; postgres-js reads it itself.
  if (/[?&]sslmode=/i.test(url)) return false;
  let hostname: string;
  try {
    hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return false;
  return hostname.includes('.');
}

// drizzle-orm 1.0 takes the tables through the relations config built by
// defineRelations, and that config is also what drizzle-graphql reads.
const { drizzle } = await import('drizzle-orm/postgres-js');
// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 rc overload resolution
const connection: any = {
  url: DATABASE_URL,
  ...(isProduction && requiresSsl(DATABASE_URL) ? { ssl: 'require' } : {}),
  // Every boot runs `CREATE SCHEMA IF NOT EXISTS "drizzle"`, and Postgres answers
  // with a NOTICE when it already does. Printing it makes a healthy restart look
  // like a failure, so notices are dropped; real errors still throw.
  onnotice: () => {},
};

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver at runtime; callers cast as needed
export type DB = any;
export const db: DB = drizzle({ connection, relations });

export { relations, schema };
export * from './schema.ts';
