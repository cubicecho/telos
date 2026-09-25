import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@telos/db';
import { printSchema } from 'graphql';
import { createSchema } from './build-schema.ts';

// Prints the schema the server actually serves, so codegen (both here and in the
// app) reads the same SDL rather than a hand-maintained copy of it. Printed with
// AI on, so the app's generated types cover the AI surface whether or not this
// instance serves it: the app asks `authConfig.ai` before touching any of it.

const { schema } = createSchema(db, { ai: true });

const __dirname = dirname(fileURLToPath(import.meta.url));

const outputDir = resolve(__dirname, '..', '__generated__');
await mkdir(outputDir, { recursive: true });
await writeFile(resolve(outputDir, 'schema.graphql'), printSchema(schema), 'utf-8');
