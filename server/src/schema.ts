import { db } from '@telos/db';
import { createSchema } from './build-schema.ts';

const { schema, entities } = createSchema(db);

export { schema, entities };
