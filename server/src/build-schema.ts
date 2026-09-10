import { buildSchema, type GeneratedEntities } from '@vantreeseba/drizzle-graphql';
import type { GraphQLSchema } from 'graphql';
import { applyAuthExtension } from './resolvers/auth.ts';
import { applyLanesExtension } from './resolvers/lanes.ts';
import { applyTodosExtension } from './resolvers/todos.ts';
import { onWrite } from './resolvers/write-guards.ts';
import { contextValues, features, scope } from './tenancy.ts';

// The whole CRUD surface is generated from the Drizzle schema — there are no
// hand-written create/read/update/delete resolvers, and adding a column to a
// table is all it takes to expose it. What generated CRUD cannot express is
// layered on top by the two extensions below.
//
// Kept separate from schema.ts, which binds it to the real database, so a test
// can build the same schema against a throwaway one.

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver
type AnyDb = any;

export function createSchema(db: AnyDb): { schema: GraphQLSchema; entities: GeneratedEntities<AnyDb> } {
  const { schema: drizzleSchema, entities } = buildSchema(db, {
    prefixes: {
      insert: 'create',
      update: 'update',
      delete: 'delete',
    },
    // Table keys are plural (`todos`); derive singular names for the type and
    // single-row fields (Todo, todo, createTodo).
    typeNameMapper: 'singularize',
    // Multi-tenancy lives in the generated SQL, not in resolver wrappers.
    scope,
    contextValues,
    features,
    onWrite,
  });

  let schema = applyAuthExtension(drizzleSchema);
  schema = applyTodosExtension(schema);
  schema = applyLanesExtension(schema);

  return { schema, entities };
}
