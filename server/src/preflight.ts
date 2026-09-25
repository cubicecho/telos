// Environment checks that must run before anything opens a connection or signs a
// token. Imported for its side effects as the very first import of index.ts, so
// a misconfigured instance fails with a sentence rather than a stack trace.

import { DEV_SECRET } from './config.ts';

function fatal(message: string): never {
  console.error(`FATAL: ${message}`);
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  fatal('DATABASE_URL is required. Copy .env.example to .env, then run `npm run db:up` for a local Postgres.');
}

if (process.env.NODE_ENV === 'production') {
  const secret = process.env.AUTH_SECRET || process.env.JWT_SECRET;
  if (!secret || secret === DEV_SECRET) {
    // Sessions are signed with this. A known secret means anyone can forge one.
    fatal('AUTH_SECRET must be set to a strong random value in production. Generate one with `openssl rand -hex 32`.');
  }
}
