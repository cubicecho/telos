import './preflight.ts';

import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@telos/db';
import cors from 'cors';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import express from 'express';
import { magicLinkExposed, magicLinkRequired } from './config.ts';
import { createGraphQLRouter } from './routes/graphql.ts';
import { createStaticHandler } from './static.ts';

export type { Context } from './context.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3002);
const staticDir = join(__dirname, '../../app/dist');

// Migrations run at boot so `docker compose up` on a fresh volume is the whole
// install. They are idempotent; a container restart is a no-op.
await migrate(db, { migrationsFolder: join(__dirname, '../../db/drizzle') });

const app = express();
const httpServer = createServer(app);
const serveStatic = createStaticHandler(staticDir);

app.use(cors());
app.use('/graphql', await createGraphQLRouter(httpServer));
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});
app.use((req, res) => serveStatic(req, res));

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Telos ready at http://localhost:${PORT}`);
  console.log(`   GraphQL at http://localhost:${PORT}/graphql`);
  if (!magicLinkRequired()) {
    console.warn('⚠️  AUTH_MAGIC_LINK is off: any email address signs in without a link. Private networks only.');
  } else if (magicLinkExposed()) {
    console.warn('⚠️  EXPOSE_MAGIC_LINK is on: sign-in links are returned in API responses. Private networks only.');
  }
});
