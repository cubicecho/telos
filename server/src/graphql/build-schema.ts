import type { DB } from '@telos/db';
import { AUTH_TABLES, SERVER_TABLES } from '@telos/db/schema';
import { buildSchema } from '@vantreeseba/drizzle-graphql';
import { applyAgentDefaultsExtension } from '../agents/agent-defaults-resolvers.ts';
import { applyAgentInstructionsExtension } from '../agents/instructions.ts';
import { applyAgentsExtension } from '../agents/resolvers.ts';
import { applyAccountActivityExtension } from '../ai/account-activity.ts';
import { applyAnswersExtension } from '../ai/answers.ts';
import { applyAiReadsExtension } from '../ai/reads.ts';
import { applyRequestsExtension } from '../ai/requests.ts';
import { applyAiSetupExtension } from '../ai/setup.ts';
import { applyAiStatusExtension } from '../ai/status.ts';
import { applyAiSwitchesExtension } from '../ai/switches.ts';
import { applyApiKeysExtension } from '../auth/api-keys.ts';
import { applyBetterAuthExtension } from '../auth/endpoints.ts';
import { applyAuthExtension } from '../auth/resolvers.ts';
import { applyBoardChangesExtension } from '../board/board-changed.ts';
import { applyCardMarksExtension } from '../board/card-marks.ts';
import { applyLanesExtension } from '../board/lanes-resolvers.ts';
import { applyBoardTemplatesExtension } from '../board/templates.ts';
import { applyChangesExtension } from '../changes/resolvers.ts';
import { applyArtifactsExtension } from '../runs/artifacts.ts';
import { applyRunsExtension } from '../runs/resolvers.ts';
import { applySessionDeletesExtension } from '../runs/session-deletes.ts';
import { applySsoSetupExtension } from '../sso/resolvers.ts';
import { applyNotesExtension } from '../todos/notes.ts';
import { applyTodosExtension } from '../todos/resolvers.ts';
import { applyCallerPermissions } from './permissions.ts';
import { contextValues, features, scope } from './tenancy.ts';
import { onWrite } from './write-guards.ts';

// The whole CRUD surface is generated from the Drizzle schema — there are no
// hand-written create/read/update/delete resolvers, and adding a column to a
// table is all it takes to expose it. What generated CRUD cannot express is
// layered on top by the two extensions below.
//
// Kept separate from schema.ts, which binds it to the real database, so a test
// can build the same schema against a throwaway one.

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
const AI_TABLES = ['agents', 'prompts', 'mcpServers', 'runs', 'artifacts'];

/** A lane's agent and routes, which mean nothing without agents. */
const AI_LANE_COLUMNS = [
  'agentId',
  'onSuccessLaneId',
  'onFailureLaneId',
  'archiveOnSuccess',
  'wipLimit',
  'maxAttempts',
];

export function createSchema(db: DB, options: SchemaOptions) {
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
    // Deleting a todo archives it: `restoreTodo` brings it back, and only
    // `deleteTodo(hard: true)` removes it. `scope: 'root'` keeps an archived
    // todo readable through the rows that point at it — a run, a note, a
    // dependency — since history should still say what it was about.
    softDelete: { todos: { column: 'archivedAt', hardDelete: true, scope: 'root' } },
    // better-auth's tables: sessions, key hashes and magic-link tokens. Only
    // better-auth reads or writes them (auth.ts), so they generate nothing.
    // Nor does the instance's settings row, which belongs to no user.
    //
    // An agent's API key is write-only: `setAgentApiKey` stores it and only
    // the runner's `claimRun` reads it back. An MCP server's headers
    // are the same, through `setMcpServerSecret`. With AI off, the agent
    // machinery is not in the schema at all.
    exclude: options.ai
      ? { tables: [...AUTH_TABLES, ...SERVER_TABLES], columns: { agents: ['apiKey'], mcpServers: ['headers'] } }
      : { tables: [...AUTH_TABLES, ...SERVER_TABLES, ...AI_TABLES], columns: { lanes: AI_LANE_COLUMNS } },
  });

  let schema = applyAuthExtension(drizzleSchema, options);
  schema = applySsoSetupExtension(schema);
  schema = applyBetterAuthExtension(schema, db, options);
  schema = applyTodosExtension(schema);
  schema = applyLanesExtension(schema);
  schema = applyNotesExtension(schema);
  schema = applyBoardTemplatesExtension(schema);
  schema = applyBoardChangesExtension(schema);
  schema = applyCardMarksExtension(schema, { ai: options.ai });
  schema = applyChangesExtension(schema);
  if (options.ai) {
    schema = applyApiKeysExtension(schema);
    schema = applyAiSwitchesExtension(schema);
    schema = applyRequestsExtension(schema);
    schema = applyAnswersExtension(schema);
    schema = applyAgentsExtension(schema);
    schema = applyAgentDefaultsExtension(schema);
    schema = applyRunsExtension(schema);
    schema = applyArtifactsExtension(schema);
    schema = applySessionDeletesExtension(schema);
    schema = applyAiStatusExtension(schema);
    schema = applyAiSetupExtension(schema);
    schema = applyAccountActivityExtension(schema);
    schema = applyAiReadsExtension(schema);
    schema = applyAgentInstructionsExtension(schema);
  }
  // Last, so it sees every root field the extensions above added.
  schema = applyCallerPermissions(schema, entities);

  return { schema, entities };
}
