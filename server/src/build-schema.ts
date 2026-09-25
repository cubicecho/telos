import { AUTH_TABLES, SERVER_TABLES } from '@telos/db/schema';
import { buildSchema, GraphQLDateTime } from '@vantreeseba/drizzle-graphql';
import { applyActorLock } from './resolvers/actor-lock.ts';
import { applyAgentsExtension } from './resolvers/agents.ts';
import { applyAiSwitchesExtension } from './resolvers/ai-switches.ts';
import { applyApiKeysExtension } from './resolvers/api-keys.ts';
import { applyAuthExtension } from './resolvers/auth.ts';
import { applyLanesExtension } from './resolvers/lanes.ts';
import { applyRequestsExtension } from './resolvers/requests.ts';
import { applyRunsExtension } from './resolvers/runs.ts';
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
export interface SchemaOptions {
  /**
   * Whether the server offers AI (config.ts `aiAvailable`). Off, the AI
   * extensions are never applied, so the schema has no AI fields for anyone to
   * call. On, the instance's own switch still decides, per request.
   */
  ai: boolean;
}

/** Tables that exist in the API only while the instance has AI on. */
const AI_TABLES = ['agents', 'runs', 'artifacts'];

/** A lane's station settings, which mean nothing without agents. */
const AI_LANE_COLUMNS = [
  'agentId',
  'contract',
  'prompt',
  'onSuccessLaneId',
  'onFailureLaneId',
  'wipLimit',
  'maxAttempts',
];

export function createSchema(db: AnyDb, options: SchemaOptions) {
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
    // better-auth's tables: sessions, key hashes and magic-link tokens. Only
    // better-auth reads or writes them (auth.ts), so they generate nothing.
    // Nor does the instance's settings row, which belongs to no user.
    //
    // An agent's API key is write-only: `setAgentApiKey` stores it and only
    // the runner's `claimRun` reads it back. With AI off, the agent machinery
    // is not in the schema at all.
    exclude: options.ai
      ? { tables: [...AUTH_TABLES, ...SERVER_TABLES], columns: { agents: ['apiKey'] } }
      : { tables: [...AUTH_TABLES, ...SERVER_TABLES, ...AI_TABLES], columns: { lanes: AI_LANE_COLUMNS } },
  });

  let schema = applyAuthExtension(drizzleSchema, options);
  schema = applyTodosExtension(schema);
  schema = applyLanesExtension(schema);
  if (options.ai) {
    schema = applyApiKeysExtension(schema);
    schema = applyAiSwitchesExtension(schema);
    schema = applyRequestsExtension(schema);
    schema = applyAgentsExtension(schema);
    schema = applyRunsExtension(schema);
  }
  // Last, so it sees every mutation the extensions above added.
  schema = applyActorLock(schema);

  return { schema, entities };
}
