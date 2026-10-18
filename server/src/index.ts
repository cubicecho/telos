import './core/preflight.ts';

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@telos/db';
import { type EmbeddedRunner, startRunner } from '@telos/runner/embed';
import cors from 'cors';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import express from 'express';
import { createAuthHost } from './auth/auth-host.ts';
import { createRateLimiter } from './auth/rate-limit.ts';
import {
  appUrl,
  oidcRedirectUri,
  runnerKey,
  secureLocalNet,
  serverUrl,
  smtpConfigured,
  trustProxy,
} from './core/config.ts';
import { createContextFactory } from './graphql/context-factory.ts';
import { createGraphQLRouter } from './graphql/handler.ts';
import { ai, schema } from './graphql/schema.ts';
import { mountSso } from './http/sso.ts';
import { createStaticHandler } from './http/static.ts';
import { mountMcp } from './mcp/endpoint.ts';
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

const app = express();
const httpServer = createServer(app);
const serveStatic = createStaticHandler(staticDir);
// One per process, so the sign-in throttle counts across every request.
const limiter = createRateLimiter();
const contextFor = createContextFactory(db, authHost, limiter, { ai, runnerKey: runnerKey() });
const { version } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };

// Which proxy hops may set X-Forwarded-For. `req.ip` keys the sign-in throttle.
app.set('trust proxy', trustProxy());
app.use(cors());
app.use('/graphql', await createGraphQLRouter(httpServer, contextFor));
const mcp = mountMcp(app, { ai, db, schema, contextFor, version });
// Always mounted: a provider can be paired while the server runs.
mountSso(app, authHost);
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});
app.use((req, res) => serveStatic(req, res));

httpServer.listen(PORT, '0.0.0.0', () => {
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
// then close open MCP streams, so the HTTP server is not left waiting on them.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      stopPruning?.();
      await runner?.stop().catch((error: unknown) => console.error('[runner] stop failed:', error));
      await mcp?.close().catch((error: unknown) => console.error('[mcp] close failed:', error));
      httpServer.close(() => process.exit(0));
    })();
  });
}
