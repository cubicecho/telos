import { db } from '@telos/db';
import { createAuth } from './auth.ts';
import { createSchema } from './build-schema.ts';
import { aiAvailable } from './config.ts';

const ai = aiAvailable();
const { schema, entities } = createSchema(db, { ai });
const auth = createAuth(db);

export { ai, auth, schema, entities };
