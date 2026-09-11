import { buildSchema, GraphQLDateTime } from '@vantreeseba/drizzle-graphql';
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

// The return type is inferred rather than written out: `GeneratedEntities` is
// keyed by the naming config, so spelling it here would mean restating
// `typeNameMapper` in a second place that could disagree with the first.
export function createSchema(db: AnyDb) {
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
    // Timestamps get their *input* scalar declared rather than detected, and
    // the declaring is the point: an overridden column skips the library's own
    // input remapper, which runs `new Date(value)` on a timestamp behind a null
    // guard that only covers `notNull` columns. `new Date(null)` is the epoch,
    // not NaN, so it passes every validity check the remapper makes — clearing
    // a nullable timestamp through a generated write would silently store
    // 1970-01-01 instead of NULL. Clearing a due date is exactly that write.
    //
    // Input only, via the `{ input }` form, because the same override on the
    // output side would skip the remapper's `Date -> toISOString()` step and
    // hand resolvers a `Date` where they have always had a string. Over HTTP
    // that JSON-serializes identically, but it is a change nothing here needs.
    //
    // `GraphQLDateTime` is the scalar detection already picks, so the SDL is
    // unchanged and no generated client type moves. A rule rather than a
    // per-column list, so the next nullable timestamp is covered by existing
    // code instead of by someone remembering this comment.
    mapColumnType: (column) => (column.columnType === 'PgTimestamp' ? { input: GraphQLDateTime } : undefined),
    onWrite,
  });

  let schema = applyAuthExtension(drizzleSchema);
  schema = applyTodosExtension(schema);
  schema = applyLanesExtension(schema);

  return { schema, entities };
}
