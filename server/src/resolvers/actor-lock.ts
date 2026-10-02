import { defaultFieldResolver, GraphQLError, type GraphQLObjectType, type GraphQLSchema } from 'graphql';
import { type Context, isAiActor } from '../context.ts';
import { DOOR_TOOLS, switchedOff } from '../door.ts';
import { assertAiReach } from './ai-reach.ts';

// What AI may write. An MCP client or an agent can work the board: make a
// project, talk a draft over, add todos and move them, send one round again,
// stop a run, record what it made. What stays a person's is everything that
// decides how far AI reaches: the AI switches, keys and secrets, agents and
// their MCP servers, deleting a project, and changing many rows at once.
//
// Two things narrow that for a caller. What it sees is less than its user
// does (tenancy.ts), and a mutation is held to that before it runs
// (ai-reach.ts). And a key has a switch per tool of the door (door.ts,
// `setApiKeyTools`): a mutation every tool of which is off for the key is
// refused here, and so is a query, whichever endpoint it came in by. A run has
// no switches and gets all of it.
//
// A note is its author's to take back: `editTodoNote` and `deleteTodoNote`
// hold a caller to the notes it signed (resolvers/notes.ts). `recordArtifact`
// is how a client says what it made; a run has its own way
// (resolvers/artifacts.ts).
//
// An allowlist over the whole Mutation type rather than a check per resolver,
// so a mutation added later is closed to AI until someone opens it here.
// Applied last in createSchema, after every extension has added its fields.

/**
 * The only mutations an AI caller may make. The MCP door's mutations are
 * exactly these (mcp.graphql), which __tests__/mcp.test.ts holds it to.
 */
export const AI_MUTATIONS = new Set([
  'submitRequest',
  'cancelRequest',
  'addTodoNote',
  'editTodoNote',
  'deleteTodoNote',
  'recordArtifact',
  'createProject',
  'updateProject',
  'createTodo',
  'updateTodo',
  'deleteTodo',
  'restoreTodo',
  'moveTodo',
  'setTodoDependencies',
  'retryTodo',
  'runTodo',
  'cancelRun',
  'startDraft',
  'sayToDraft',
  'stopDraft',
  'makeTodoFromDraft',
  'discardDraft',
  'saveBoardTemplate',
  'applyBoardTemplate',
]);

/**
 * The only mutations the runner may make. It owns no rows, so generated CRUD
 * would refuse it anyway; this says so plainly, and keeps it that way for
 * mutations that do not ask for a user.
 */
export const RUNNER_MUTATIONS = new Set([
  'claimRun',
  'heartbeatRun',
  'finishRun',
  'finishProbe',
  'claimDraft',
  'finishDraft',
  'takeSessionDeletes',
  'finishSessionDelete',
]);

/**
 * Why `name` is closed to the caller, or null when it is open.
 *
 * @param name The mutation.
 * @param args What it was called with.
 * @param context The request.
 * @returns The refusal, or null.
 */
function refusal(name: string, args: Record<string, unknown>, context: Context): string | null {
  if (context.actor.kind === 'system') {
    return RUNNER_MUTATIONS.has(name) ? null : `${name} is not open to the runner.`;
  }
  if (isAiActor(context) && !AI_MUTATIONS.has(name)) {
    return `${name} is not open to AI.`;
  }
  return switchedOff(name, args, context.actor) ? `${name} is switched off for this key.` : null;
}

function forbidden(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'FORBIDDEN' } });
}

/**
 * Holds a key to its switches on the queries the door's tools read with. The
 * rows a query returns are tenancy's to narrow; this only says whether the key
 * may ask at all.
 *
 * @param schema The finished schema, whose Query fields are wrapped in place.
 * @returns Nothing.
 */
function lockQueries(schema: GraphQLSchema): void {
  const query = schema.getQueryType();
  if (!query) {
    return;
  }
  const read = new Set(DOOR_TOOLS.filter((tool) => !tool.writes).flatMap((tool) => tool.fields));
  for (const [name, field] of Object.entries(query.getFields())) {
    if (!read.has(name)) {
      continue;
    }
    const resolve = field.resolve ?? defaultFieldResolver;
    field.resolve = (parent, args, context: Context, info) => {
      if (switchedOff(name, args, context.actor)) {
        throw forbidden(`${name} is switched off for this key.`);
      }
      return resolve(parent, args, context, info);
    };
  }
}

export function applyActorLock(schema: GraphQLSchema): GraphQLSchema {
  lockQueries(schema);
  const mutation = schema.getMutationType() as GraphQLObjectType | null | undefined;
  if (!mutation) return schema;
  for (const [name, field] of Object.entries(mutation.getFields())) {
    const resolve = field.resolve ?? defaultFieldResolver;
    field.resolve = async (parent, args, context: Context, info) => {
      const refused = refusal(name, args, context);
      if (refused) throw forbidden(refused);
      if (isAiActor(context)) await assertAiReach(name, args, context);
      return resolve(parent, args, context, info);
    };
  }
  return schema;
}
