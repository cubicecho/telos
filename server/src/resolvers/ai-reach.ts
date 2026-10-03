import * as dbSchema from '@telos/db/schema';
import { and, eq } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import type { Context } from '../context.ts';
import { requireAuth } from './auth.ts';
import { loadAiProject, loadAiTodo } from './requests.ts';

// What an AI caller's arguments may name. The mutations a person's screens call
// check that a row is the caller's and no more, since a person may touch all of
// their own. An AI caller sees less (tenancy.ts): a project with AI off, or a
// todo it was told to ignore, is not there for it. So before one of those
// mutations runs for a key or an agent, every id it was handed is held to what
// that caller could have read, and answered NOT_FOUND otherwise.
//
// Stated here as a table rather than in each resolver, so the resolvers stay
// the person's and a mutation opened to AI later (actor-lock.ts) has one place
// to say what its arguments are. Generated writes need none of this: their rows
// are scoped by tenancy.ts and their foreign keys by write-guards.ts. The draft
// and request mutations check for themselves.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

/** What an argument names. */
type Named = 'project' | 'todo' | 'todos' | 'lane' | 'run';

/** The id arguments of each owner-checked mutation open to AI, and what each names. */
export const AI_REACH: Record<string, Record<string, Named>> = {
  moveTodo: { id: 'todo', laneId: 'lane' },
  setTodoDependencies: { id: 'todo', dependsOn: 'todos' },
  retryTodo: { id: 'todo' },
  runTodo: { id: 'todo' },
  cancelRun: { id: 'run' },
  saveBoardTemplate: { projectId: 'project' },
  applyBoardTemplate: { projectId: 'project' },
};

/** What each is called in the NOT_FOUND a caller sees. */
const ENTITY: Record<Named, string> = { project: 'Project', todo: 'Todo', todos: 'Todo', lane: 'Lane', run: 'Run' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(what: string): GraphQLError {
  return new GraphQLError(`${what} not found`, { extensions: { code: 'NOT_FOUND' } });
}

/**
 * A lane on a board AI may see, or NOT_FOUND.
 *
 * @param context The request.
 * @param userId The caller.
 * @param id The lane.
 * @returns Nothing.
 */
async function assertAiLane(context: Context, userId: string, id: string): Promise<void> {
  const [lane] = await (context.db as AnyRow)
    .select({ id: dbSchema.lanes.id })
    .from(dbSchema.lanes)
    .innerJoin(dbSchema.projects, eq(dbSchema.projects.id, dbSchema.lanes.projectId))
    .where(and(eq(dbSchema.lanes.id, id), eq(dbSchema.lanes.userId, userId), eq(dbSchema.projects.aiEnabled, true)));
  if (!lane) {
    throw notFound('Lane');
  }
}

/**
 * A run of a todo AI may see, or NOT_FOUND. A draft's reply has no todo, and
 * is stopped through its draft.
 *
 * @param context The request.
 * @param userId The caller.
 * @param id The run.
 * @returns Nothing.
 */
async function assertAiRun(context: Context, userId: string, id: string): Promise<void> {
  const [run] = await (context.db as AnyRow)
    .select({ todoId: dbSchema.runs.todoId })
    .from(dbSchema.runs)
    .where(and(eq(dbSchema.runs.id, id), eq(dbSchema.runs.userId, userId)));
  if (!run?.todoId) {
    throw notFound('Run');
  }
  await loadAiTodo(context, userId, run.todoId).catch(() => {
    throw notFound('Run');
  });
}

/**
 * Holds one id to what an AI caller may see.
 *
 * @param context The request.
 * @param userId The caller.
 * @param named What the id names.
 * @param id The id.
 * @returns Nothing.
 */
async function assertSeen(context: Context, userId: string, named: Named, id: string): Promise<void> {
  // Not an id at all is not there either, rather than a database error.
  if (!UUID.test(id)) {
    throw notFound(ENTITY[named]);
  }
  if (named === 'project') {
    await loadAiProject(context, userId, id);
  } else if (named === 'lane') {
    await assertAiLane(context, userId, id);
  } else if (named === 'run') {
    await assertAiRun(context, userId, id);
  } else {
    await loadAiTodo(context, userId, id);
  }
}

/**
 * Refuses a mutation whose arguments name something its AI caller may not see.
 * Does nothing for a mutation with no entry in `AI_REACH`.
 *
 * @param name The mutation.
 * @param args Its arguments.
 * @param context The request, an AI caller's.
 * @returns Nothing.
 */
export async function assertAiReach(name: string, args: Record<string, unknown>, context: Context): Promise<void> {
  const reach = AI_REACH[name];
  if (reach === undefined) {
    return;
  }
  const userId = requireAuth(context);
  for (const [arg, named] of Object.entries(reach)) {
    const value = args[arg];
    const ids = Array.isArray(value) ? value : [value];
    for (const id of ids) {
      if (typeof id === 'string') {
        await assertSeen(context, userId, named, id);
      }
    }
  }
}
