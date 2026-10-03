import * as dbSchema from '@telos/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { resultRows } from '../blocking.ts';
import type { Context } from '../context.ts';
import { requireAuth } from './auth.ts';

// How far a run's writes go. A key is something its owner pointed at telos on
// purpose; a run is a model following a prompt about one todo. So whatever
// its agent's switches open (door.ts), a run writes only:
//
// - its own todo, the todos under it, and the todos a run of its todo created
//   (and theirs), for anything that changes a todo or its thread. A retry is
//   the same work, so it may pick up what the last attempt split off;
// - its own board, for anything that adds to a board or changes it: a todo, a
//   request, a draft, the project's text, a template made of it.
//
// It may not move, finish, archive, delete, retry, re-run or set aside its own
// todo, stop its own run, or change what its own todo waits on: what happens
// to its todo is `finishRun`'s to decide, reading the result against the lane.
// Editing its own todo's text and leaving notes on it are fine.
//
// A todo out of reach is NOT_FOUND, as one AI cannot see is (ai-reach.ts): the
// run is not told that it exists. Its own todo is FORBIDDEN, since it knows
// that one is there, and the message says why.
//
// Applied by the actor lock after the switches and ai-reach.ts, to an `agent`
// actor only. A mutation with no entry here writes nothing a run could reach
// past (notes it signed: resolvers/notes.ts) or is closed to runs already
// (`recordArtifact`, resolvers/artifacts.ts).

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyDb = any;

/** The run a request is acting for. */
interface Run {
  id: string;
  userId: string;
  todoId: string | null;
  projectId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound(what: string): GraphQLError {
  return new GraphQLError(`${what} not found`, { extensions: { code: 'NOT_FOUND' } });
}

function ownTodo(what: string): GraphQLError {
  return new GraphQLError(`A run cannot ${what} its own todo: that is decided when the run finishes.`, {
    extensions: { code: 'FORBIDDEN' },
  });
}

/**
 * The id a generated write's `where` names. A run names the one row it writes
 * by id, as the door's tools do: a filter could reach rows nobody checked.
 *
 * @param where The write's `where`.
 * @returns The id.
 */
function namedId(where: unknown): string {
  const byId = (where as { id?: unknown } | null | undefined)?.id;
  const id = (byId as { eq?: unknown } | null | undefined)?.eq;
  const exact =
    typeof where === 'object' &&
    where !== null &&
    Object.keys(where).length === 1 &&
    typeof byId === 'object' &&
    byId !== null &&
    Object.keys(byId).length === 1;
  if (!exact || typeof id !== 'string') {
    throw new GraphQLError('A run names the row it writes by id: where: { id: { eq: … } }.', {
      extensions: { code: 'BAD_USER_INPUT' },
    });
  }
  return id;
}

/**
 * The run, or null when it is gone.
 *
 * @param context The request, an agent's.
 * @returns The run.
 */
async function runOf(context: Context): Promise<Run | null> {
  const runId = context.actor.runId;
  if (!runId) {
    return null;
  }
  const [run] = await (context.db as AnyDb)
    .select({
      id: dbSchema.runs.id,
      userId: dbSchema.runs.userId,
      todoId: dbSchema.runs.todoId,
      projectId: dbSchema.runs.projectId,
    })
    .from(dbSchema.runs)
    .where(and(eq(dbSchema.runs.id, runId), eq(dbSchema.runs.userId, requireAuth(context))));
  return run ?? null;
}

/**
 * Whether a todo is in a run's reach: its own, one under it, or one a run of
 * its todo created, or one under that. One recursive statement, following
 * `parent_id` down; archived todos count, so a run can restore what it put
 * away.
 *
 * @param db The database.
 * @param run The run.
 * @param todoId The todo.
 * @returns Whether the run may write it.
 */
export async function inRunReach(db: AnyDb, run: Run, todoId: string): Promise<boolean> {
  if (!run.todoId || !UUID.test(todoId)) {
    return false;
  }
  const result = await db.execute(sql`
    WITH RECURSIVE reach(id) AS (
      SELECT ${run.todoId}::uuid
      UNION
      SELECT e.todo_id
        FROM todo_events e
        JOIN runs r ON r.id = e.run_id
       WHERE e.kind = 'create' AND e.user_id = ${run.userId} AND r.todo_id = ${run.todoId}
      UNION
      SELECT t.id
        FROM todos t
        JOIN reach ON t.parent_id = reach.id
       WHERE t.user_id = ${run.userId}
    )
    SELECT 1 AS found FROM reach WHERE id = ${todoId}::uuid LIMIT 1
  `);
  return resultRows(result).length > 0;
}

/**
 * A todo the run may write, or NOT_FOUND; its own todo, FORBIDDEN, unless
 * `own` says what it may do to it.
 *
 * @param context The request.
 * @param run The run.
 * @param todoId The todo.
 * @param own Null when the run may write its own todo, else what it may not do to it.
 * @returns Nothing.
 */
async function assertTodo(context: Context, run: Run, todoId: unknown, own: string | null): Promise<void> {
  if (typeof todoId !== 'string' || !(await inRunReach(context.db, run, todoId))) {
    throw notFound('Todo');
  }
  if (own !== null && todoId === run.todoId) {
    throw ownTodo(own);
  }
}

/**
 * A parent the run may put a todo under: none, or a todo in its reach.
 *
 * @param context The request.
 * @param run The run.
 * @param parentId The parent named, if any.
 * @returns Nothing.
 */
async function assertParent(context: Context, run: Run, parentId: unknown): Promise<void> {
  if (parentId != null) {
    await assertTodo(context, run, parentId, null);
  }
}

/**
 * The run's own board, or NOT_FOUND.
 *
 * @param run The run.
 * @param projectId The project named.
 * @returns Nothing.
 */
function assertBoard(run: Run, projectId: unknown): void {
  if (projectId !== run.projectId) {
    throw notFound('Project');
  }
}

/**
 * A draft on the run's own board, or NOT_FOUND.
 *
 * @param context The request.
 * @param run The run.
 * @param draftId The draft.
 * @returns Nothing.
 */
async function assertDraft(context: Context, run: Run, draftId: unknown): Promise<void> {
  const [draft] =
    typeof draftId === 'string' && UUID.test(draftId)
      ? await (context.db as AnyDb)
          .select({ projectId: dbSchema.drafts.projectId })
          .from(dbSchema.drafts)
          .where(and(eq(dbSchema.drafts.id, draftId), eq(dbSchema.drafts.userId, run.userId)))
      : [];
  if (draft?.projectId !== run.projectId) {
    throw notFound('Draft');
  }
}

/**
 * A run of a todo the run may write, and not the run's own todo, or NOT_FOUND.
 *
 * @param context The request.
 * @param run The run.
 * @param runId The run named.
 * @returns Nothing.
 */
async function assertRun(context: Context, run: Run, runId: unknown): Promise<void> {
  const [named] =
    typeof runId === 'string' && UUID.test(runId)
      ? await (context.db as AnyDb)
          .select({ todoId: dbSchema.runs.todoId })
          .from(dbSchema.runs)
          .where(and(eq(dbSchema.runs.id, runId), eq(dbSchema.runs.userId, run.userId)))
      : [];
  if (!named?.todoId || !(await inRunReach(context.db, run, named.todoId))) {
    throw notFound('Run');
  }
  if (named.todoId === run.todoId) {
    throw ownTodo('stop a run of');
  }
}

/** Fields of a todo whose change is the outcome of its run, not an edit. */
const OUTCOME_FIELDS = ['completedAt', 'laneId'] as const;

type Args = Record<string, AnyDb>;

/** What each mutation a run might make is held to, by name. */
const RUN_REACH: Record<string, (context: Context, run: Run, args: Args) => Promise<void>> = {
  // Adding work: on its own board, under a todo it may write when under one.
  createTodo: async (context, run, args) => {
    assertBoard(run, args.values?.projectId);
    await assertParent(context, run, args.values?.parentId);
  },
  submitRequest: async (context, run, args) => {
    assertBoard(run, args.projectId);
    await assertParent(context, run, args.parentId);
  },
  updateTodo: async (context, run, args) => {
    const id = namedId(args.where);
    const outcome = OUTCOME_FIELDS.some((field) => args.set?.[field] !== undefined);
    await assertTodo(context, run, id, outcome ? 'complete or move' : null);
    if (args.set && 'parentId' in args.set) {
      await assertParent(context, run, args.set.parentId);
    }
  },
  moveTodo: (context, run, args) => assertTodo(context, run, args.id, 'move'),
  retryTodo: (context, run, args) => assertTodo(context, run, args.id, 'retry'),
  runTodo: (context, run, args) => assertTodo(context, run, args.id, 'ask for another run of'),
  cancelRequest: (context, run, args) => assertTodo(context, run, args.id, 'cancel'),
  cancelRun: (context, run, args) => assertRun(context, run, args.id),
  // What a todo waits on changes whether it may move, which is its run's
  // outcome for the run's own todo. What it names it only reads.
  setTodoDependencies: (context, run, args) => assertTodo(context, run, args.id, 'change what waits on'),
  deleteTodo: (context, run, args) => assertTodo(context, run, namedId(args.where), args.hard ? 'delete' : 'archive'),
  restoreTodo: (context, run, args) => assertTodo(context, run, namedId(args.where), null),
  addTodoNote: (context, run, args) => assertTodo(context, run, args.todoId, null),
  // Its own board, and nothing past it.
  updateProject: async (_context, run, args) => assertBoard(run, namedId(args.where)),
  saveBoardTemplate: async (_context, run, args) => assertBoard(run, args.projectId),
  startDraft: async (_context, run, args) => assertBoard(run, args.projectId),
  sayToDraft: (context, run, args) => assertDraft(context, run, args.id),
  stopDraft: (context, run, args) => assertDraft(context, run, args.id),
  makeTodoFromDraft: (context, run, args) => assertDraft(context, run, args.id),
  discardDraft: (context, run, args) => assertDraft(context, run, args.id),
};

/** The mutations held to a run's reach. */
export const RUN_REACH_MUTATIONS: ReadonlySet<string> = new Set(Object.keys(RUN_REACH));

/**
 * The mutations open to AI that a run's reach does not need to hold, and why.
 * Every one in `AI_MUTATIONS` is here or in `RUN_REACH`, which
 * __tests__/mcp.test.ts holds the two to, so a mutation opened to AI
 * later has to say how far a run takes it.
 */
export const RUN_REACH_EXEMPT: Readonly<Record<string, string>> = {
  createProject: 'A new board touches no work.',
  applyBoardTemplate: 'Only a board with no todos takes a template.',
  editTodoNote: 'A run rewrites only the notes it left (resolvers/notes.ts).',
  deleteTodoNote: 'A run takes back only the notes it left (resolvers/notes.ts).',
  recordArtifact: 'Refused for a run (resolvers/artifacts.ts).',
};

/**
 * Refuses a run's write that reaches past its todo or its board. Does nothing
 * for a mutation with no entry in `RUN_REACH`.
 *
 * @param name The mutation.
 * @param args Its arguments.
 * @param context The request, an `agent` actor's.
 * @returns Nothing.
 */
export async function assertRunReach(name: string, args: Args, context: Context): Promise<void> {
  const rule = RUN_REACH[name];
  if (rule === undefined) {
    return;
  }
  const run = await runOf(context);
  if (run === null) {
    throw notFound('Run');
  }
  await rule(context, run, args);
}
