import { db } from '@telos/db';
import { createSchema } from './build-schema.ts';
import { aiAvailable } from './config.ts';

// The auth instance is not built here: it reads the database's OIDC pairing,
// so index.ts builds it (auth-host.ts) once migrations have run.
const ai = aiAvailable();
const { schema, entities } = createSchema(db, { ai });

export { ai, schema, entities };
