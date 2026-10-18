import './core/preflight.ts';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@telos/db';
import { type EmbeddedRunner, startRunner } from '@telos/runner/embed';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createAuthHost } from './auth/auth-host.ts';
import { appUrl, oidcRedirectUri, runnerKey, secureLocalNet, serverUrl, smtpConfigured } from './core/config.ts';
import { ai, schema } from './graphql/schema.ts';
import { createApp } from './http/app.ts';
import { stopOnSignals } from './http/shutdown.ts';
import { startPruning } from './runs/retention.ts';

export type { Context } from './core/context.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3001);
const staticDir = join(__dirname, '../../app/dist');

// Migrations run at boot so `docker compose up` on a fresh volume is the whole
// install. They are idempotent; a container restart is a no-op.
try {
  await migrate(db, { migrationsFolder: join(__dirname, '../../db/drizzle') });
} catch (error) {
  // The first thing the server does is talk to Postgres, so a misconfigured
  // DATABASE_URL surfaces here as a driver stack trace about `CREATE SCHEMA`.
  // Name the actual problem instead: nothing is listening where we were told.
  const cause = (error as { cause?: NodeJS.ErrnoException })?.cause;
  if (cause && (cause.code === 'ECONNREFUSED' || cause.code === 'ENOTFOUND' || cause.code === 'ETIMEDOUT')) {
    const { hostname, port } = new URL(process.env.DATABASE_URL ?? '');
    console.error(`✖ Cannot reach Postgres at ${hostname}:${port || 5432} (${cause.code}).`);
    console.error('  Check DATABASE_URL in .env, and that the database is up and reachable from here.');
    console.error('  If your Docker daemon is remote (`docker context ls`), a container published on');
    console.error("  127.0.0.1 is bound to the daemon host's loopback. Set POSTGRES_BIND=0.0.0.0 and");
    console.error('  re-run `npm run db:up`.');
    process.exit(1);
  }
  throw error;
}

// After migrating: it reads the OIDC pairing, if there is one.
const authHost = await createAuthHost(db);

let runner: EmbeddedRunner | undefined;
// Old runs go whenever AI does; without it there are none to prune. The change
// feed's old tombstones go either way.
const stopPruning = startPruning(db, { runs: ai });

const { version } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };
const { app, mcp } = createApp({ db, authHost, schema, ai, version, staticDir });

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Telos ready at http://localhost:${PORT}`);
  console.log(`   GraphQL at http://localhost:${PORT}/graphql`);
  if (mcp) console.log(`   MCP at http://localhost:${PORT}/mcp (API key in x-api-key)`);
  // The runner comes with the server whenever AI does. Until an admin turns AI
  // on in Settings its queue is empty and it only asks, every few seconds.
  if (ai) {
    runner = startRunner({ telosUrl: `http://127.0.0.1:${PORT}`, runnerKey: runnerKey() });
    console.log('   Runner working the lanes’ agents (idle until AI is on in Settings)');
  }
  console.log(`[auth] links point at ${appUrl()}; OIDC redirects at ${serverUrl()}`);
  const oidc = authHost.oidc();
  if (oidc) console.log(`[auth] sign-in with ${oidc.name} (${oidc.issuer}); redirect URI ${oidcRedirectUri()}`);
  if (secureLocalNet()) {
    console.warn('[auth] SECURE_LOCAL_NET is on: any email signs in without a link. Private networks only.');
  } else if (!smtpConfigured() && !oidc) {
    console.warn(
      '[auth] Nobody can sign in: set SMTP_URL to email sign-in links, set OIDC_ISSUER or pair a provider from the sign-in page, or SECURE_LOCAL_NET on a private network.',
    );
  }
});

// Stop the runner first, while the server can still take its runs' reports,
// then drain: a live board's stream is cut once the drain time is up, and the
// app reconnects it. Open MCP streams close last.
stopOnSignals(httpServer, {
  before: async () => {
    stopPruning?.();
    await runner?.stop().catch((error: unknown) => console.error('[runner] stop failed:', error));
  },
  after: async () => {
    await mcp?.close().catch((error: unknown) => console.error('[mcp] close failed:', error));
  },
});
