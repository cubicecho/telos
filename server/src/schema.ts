import { db } from '@telos/db';
import { createAuth } from './auth.ts';
import { createSchema } from './build-schema.ts';
import { aiEnabled } from './config.ts';

const ai = aiEnabled();
const { schema, entities } = createSchema(db, { ai });
const auth = createAuth(db);

export { ai, auth, schema, entities };
