import type { McpHttpHandler } from '@cubicecho/graphql-mcp';
import type { DB } from '@telos/db';
import cors from 'cors';
import express, { type Express } from 'express';
import type { GraphQLSchema } from 'graphql';
import type { AuthHost } from '../auth/auth-host.ts';
import { createRateLimiter, type RateLimiter } from '../auth/rate-limit.ts';
import { runnerKey, trustProxy } from '../core/config.ts';
import { HTTP_DEFAULTS } from '../core/defaults.ts';
import { createContextFactory } from '../graphql/context-factory.ts';
import { createGraphQLHandler } from '../graphql/handler.ts';
import { mountMcp } from '../mcp/endpoint.ts';
import { mountProtectedResource } from './protected-resource.ts';
import { mountSso } from './sso.ts';
import { createStaticHandler } from './static.ts';

/** What the app talks to. Tests pass PGlite and a fixed auth host. */
export interface AppDeps {
  // biome-ignore lint/suspicious/noExplicitAny: db type varies by driver (postgres-js, PGlite in tests)
  db: DB | any;
  /** Hands out the current auth instance; pairing a provider rebuilds it. */
  authHost: AuthHost;
  /** The schema both doors serve (graphql/schema.ts in production). */
  schema: GraphQLSchema;
  /** Whether the server offers AI (config.ts `aiAvailable`). */
  ai: boolean;
  /** The server's version, as /mcp tells its clients. */
  version: string;
  /**
   * The sign-in throttle, one per process so it counts across requests.
   * @defaultValue `createRateLimiter()`
   */
  limiter?: RateLimiter;
  /** The built web client's directory. Left out in tests. */
  staticDir?: string;
}

/** What `createApp` hands back. */
export interface BuiltApp {
  /** The Express app, not listening. */
  app: Express;
  /** The MCP handler, whose streams shutdown closes, or null with AI off. */
  mcp: McpHttpHandler | null;
}

/**
 * Builds the Express app: /graphql, /mcp, the OIDC redirects, the
 * protected-resource metadata, /healthz and the
 * web client. It does not listen, migrate or start timers, so a test builds the
 * same app production runs and drives it over HTTP.
 *
 * @param deps - What the app talks to.
 * @returns The app and the MCP handler.
 */
export function createApp({
  db,
  authHost,
  schema,
  ai,
  version,
  limiter = createRateLimiter(),
  staticDir,
}: AppDeps): BuiltApp {
  const app = express();
  // Which proxy hops may set X-Forwarded-For. `req.ip` keys the sign-in throttle.
  app.set('trust proxy', trustProxy());
  app.use(cors());
  const contextFor = createContextFactory(db, authHost, limiter, { ai, runnerKey: runnerKey() });

  const graphql = createGraphQLHandler(schema, contextFor, authHost);
  // Yoga reads a body Express already parsed, so this is where the size cap goes. Over it: 413.
  app.use(graphql.graphqlEndpoint, express.json({ limit: HTTP_DEFAULTS.bodyLimit }));
  // `all`, not `use`: a mounted `use` strips the path, and Yoga matches graphqlEndpoint itself.
  app.all(graphql.graphqlEndpoint, (req, res) => graphql(req, res));

  const mcp = mountMcp(app, { ai, db, schema, contextFor, version });
  // Always mounted: a provider can be paired while the server runs.
  mountSso(app, authHost);
  // Where a device app learns which provider issues tokens for this API (RFC 9728).
  mountProtectedResource(app, authHost);
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });
  if (staticDir !== undefined) {
    const serveStatic = createStaticHandler(staticDir);
    app.use((req, res) => serveStatic(req, res));
  }
  return { app, mcp };
}
