import * as dbSchema from '@telos/db/schema';
import type { BuildSchemaConfig, WriteHookPayload } from '@vantreeseba/drizzle-graphql';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { assertNoBlockedCompletions, resultRows } from '../blocking.ts';
import { type Context, isAiActor } from '../context.ts';
import { DOOR_TOOL_NAMES } from '../door.ts';
import { assertCompletionMatchesLane, assertEveryProjectHasLanes, realignLanes, seedMissingLanes } from '../lanes.ts';
import { stampActor } from '../provenance.ts';
import { cancelRunsUnder } from '../ready.ts';
import { reachable } from '../tenancy.ts';
import { requireAuth } from './auth.ts';

// A row scope confines reads, updates and deletes, but it cannot reach a plain
// insert, and it says nothing about the rows a foreign key *points at*. These
// hooks close the two holes that leaves:
//
//   1. Ownership on insert — every id a caller can state must be theirs, and
//      for an AI caller one AI may see.
//   2. Blocking on completion — a write that marks a todo done goes through the
//      same check `completeTodo` does, so the generated `updateTodo` cannot
//      route around the dependency rule.
//
// They also stamp the actor on the transaction before anything touches a todo,
// so the history trigger can say who did it (provenance.ts).
//
// They run inside the mutation's own transaction, so a throw rolls the write
// back and there is no window between the check and the write.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyTable = any;
type Row = Record<string, unknown>;

/** A foreign key and the parent table that says whether the caller owns its target. */
interface ForeignKey {
  /** Column property name on the referencing table. */
  key: string;
  /** Name used in the "not found" a caller sees — never leak another user's row. */
  entity: string;
  parent: AnyTable;
  /** The parent table's key, which names what of it the caller may reach (tenancy.ts). */
  name: 'projects' | 'todos' | 'labels' | 'lanes' | 'agents';
}

const project: ForeignKey = { key: 'projectId', entity: 'Project', parent: dbSchema.projects, name: 'projects' };
const todo: ForeignKey = { key: 'todoId', entity: 'Todo', parent: dbSchema.todos, name: 'todos' };
const label: ForeignKey = { key: 'labelId', entity: 'Label', parent: dbSchema.labels, name: 'labels' };
const lane: ForeignKey = { key: 'laneId', entity: 'Lane', parent: dbSchema.lanes, name: 'lanes' };
const parentTodo: ForeignKey = { key: 'parentId', entity: 'Todo', parent: dbSchema.todos, name: 'todos' };
const agent: ForeignKey = { key: 'agentId', entity: 'Agent', parent: dbSchema.agents, name: 'agents' };
const onSuccessLane: ForeignKey = { key: 'onSuccessLaneId', entity: 'Lane', parent: dbSchema.lanes, name: 'lanes' };
const onFailureLane: ForeignKey = { key: 'onFailureLaneId', entity: 'Lane', parent: dbSchema.lanes, name: 'lanes' };
const newTodoLane: ForeignKey = { key: 'newTodoLaneId', entity: 'Lane', parent: dbSchema.lanes, name: 'lanes' };

const FOREIGN_KEYS: Record<string, ForeignKey[]> = {
  projects: [newTodoLane],
  lanes: [project, agent, onSuccessLane, onFailureLane],
  todos: [project, lane, parentTodo],
  todoLabels: [todo, label],
  projectLabels: [project, label],
  todoNotes: [todo],
};

/**
 * The rows a mutation is about to write: `values` on a create (one row or a
 * list), `set` on an update, one `set` per entry on a batch update. A delete
 * writes nothing and so has nothing to check.
 */
export function writtenRows(args: { values?: Row | Row[]; set?: Row; updates?: Array<{ set?: Row }> }): Row[] {
  if (args.values) return Array.isArray(args.values) ? args.values : [args.values];
  if (args.updates) return args.updates.flatMap((entry) => (entry.set ? [entry.set] : []));
  return args.set ? [args.set] : [];
}

/**
 * Refuses a write that points at a row the caller may not reach: someone
 * else's, or for an AI caller one AI may not see, which is the same answer.
 *
 * @param tx The mutation's transaction.
 * @param context The request.
 * @param rows The rows being written.
 * @param foreignKeys The foreign keys to check on them.
 * @returns Nothing.
 */
async function assertForeignKeysOwned(
  tx: AnyTable,
  context: Context,
  rows: Row[],
  foreignKeys: ForeignKey[],
): Promise<void> {
  for (const fk of foreignKeys) {
    const referenced = [
      ...new Set(rows.map((row) => row[fk.key]).filter((id): id is string => typeof id === 'string')),
    ];
    if (referenced.length === 0) continue;
    const owned: Array<{ id: string }> = await tx
      .select({ id: fk.parent.id })
      .from(fk.parent)
      .where(and(inArray(fk.parent.id, referenced), reachable(context, fk.name, fk.parent)));
    const ownedIds = new Set(owned.map((row) => row.id));
    if (referenced.some((id) => !ownedIds.has(id))) {
      // NOT_FOUND, not FORBIDDEN: "you may not touch this" would confirm the row
      // exists, which is itself something the caller is not entitled to know.
      throw new GraphQLError(`${fk.entity} not found`, { extensions: { code: 'NOT_FOUND' } });
    }
  }
}

/** Whether this write is putting a non-null `completedAt` on any row. */
function marksComplete(args: Parameters<typeof writtenRows>[0]): boolean {
  return writtenRows(args).some((row) => 'completedAt' in row && row.completedAt != null);
}

/** Whether this write states a todo's completion, either way. */
function statesCompletion(args: Parameters<typeof writtenRows>[0]): boolean {
  return writtenRows(args).some((row) => 'completedAt' in row);
}

/** Whether this write states a todo's lane. */
function statesLane(args: Parameters<typeof writtenRows>[0]): boolean {
  return writtenRows(args).some((row) => 'laneId' in row);
}

/** Whether this write states any of `keys`. */
function states(args: Parameters<typeof writtenRows>[0], ...keys: string[]): boolean {
  return writtenRows(args).some((row) => keys.some((key) => key in row));
}

/** The project columns only a switch mutation writes, and the mutation to name for each. */
const PROJECT_SWITCHES = [
  { key: 'aiEnabled', message: 'Use setProjectAiEnabled to switch AI on or off for a project.' },
  { key: 'autoRun', message: 'Use setProjectAutoRun to switch auto-run on or off for a project.' },
];

/**
 * The AI switches are only ever flipped by a person, through the mutations in
 * ai-switches.ts, which also stop whatever the switch was letting run. A
 * generated write would flip the flag and leave the rest running.
 */
function assertAiSwitchUntouched(args: Parameters<typeof writtenRows>[0]): void {
  for (const { key, message } of PROJECT_SWITCHES) {
    if (states(args, key)) {
      throw new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
    }
  }
}

/** What of a project an AI caller may state. The rest is a person's: its switches, and archiving it. */
const AI_PROJECT_COLUMNS = new Set(['id', 'name', 'description', 'context']);

/**
 * Holds an AI caller's project write to the columns it may state. A project it
 * makes is open to AI from the start: it could not otherwise see what it made,
 * and its account's and the instance's switches are already on or it would not
 * be here.
 *
 * @param args The mutation's arguments, whose rows are marked in place.
 * @param context The request.
 * @param operation Which write it is.
 * @returns Nothing.
 */
function holdAiProjectWrite(
  args: Parameters<typeof writtenRows>[0],
  context: Context,
  operation: WriteHookPayload['operation'],
): void {
  if (!isAiActor(context)) return;
  for (const row of writtenRows(args)) {
    const closed = Object.keys(row).find((key) => !AI_PROJECT_COLUMNS.has(key));
    if (closed !== undefined) {
      throw new GraphQLError(`Only a person can set a project's ${closed}.`, { extensions: { code: 'FORBIDDEN' } });
    }
    if (operation === 'insert') {
      row.aiEnabled = true;
    }
  }
}

/**
 * "AI ignores this" is a person's instruction to agents, so no agent or key may
 * set it or, more to the point, clear it.
 */
function assertIgnoreFlagFromPerson(args: Parameters<typeof writtenRows>[0], context: Context): void {
  if (!states(args, 'aiIgnored') || context.actor.kind === 'user') return;
  throw new GraphQLError('Only a person can change whether AI ignores a todo.', {
    extensions: { code: 'FORBIDDEN' },
  });
}

/**
 * Asking for a run is `runTodo`'s: it checks the lane's agent would take the todo,
 * and records who asked.
 */
function assertRunRequestUntouched(args: Parameters<typeof writtenRows>[0]): void {
  if (states(args, 'runRequestedAt')) {
    throw new GraphQLError('Use runTodo to ask for a todo to be run.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
}

/**
 * People write plain notes. Reports and verdicts are what a run leaves behind,
 * and the server writes those itself, so a generated insert cannot pass one off.
 */
function assertPlainNotes(args: Parameters<typeof writtenRows>[0]): void {
  if (writtenRows(args).every((row) => row.kind === undefined || row.kind === 'note')) return;
  throw new GraphQLError('Only notes of kind "note" can be written directly.', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

/**
 * A todo's parent is in its own project, and following parents never comes back
 * around. Checked over the caller's todos after the write, for the reason the
 * completion invariant is: the rows a `where` touched are not knowable before.
 */
async function assertParentsSound(tx: AnyTable, userId: string): Promise<void> {
  const crossProject = resultRows(
    await tx.execute(sql`
      SELECT 1 FROM todos child JOIN todos parent ON parent.id = child.parent_id
      WHERE child.user_id = ${userId} AND parent.project_id <> child.project_id
      LIMIT 1
    `),
  );
  if (crossProject.length > 0) {
    throw new GraphQLError("A todo's parent must be in the same project.", { extensions: { code: 'BAD_USER_INPUT' } });
  }
  // The depth bound only stops the walk; any chain that long has already met a
  // repeat, since no user has that many todos stacked in one line.
  const cycles = resultRows(
    await tx.execute(sql`
      WITH RECURSIVE chain(start_id, parent_id, depth) AS (
        SELECT id, parent_id, 1 FROM todos WHERE user_id = ${userId} AND parent_id IS NOT NULL
        UNION ALL
        SELECT chain.start_id, t.parent_id, chain.depth + 1
        FROM chain JOIN todos t ON t.id = chain.parent_id
        WHERE t.parent_id IS NOT NULL AND chain.start_id <> chain.parent_id AND chain.depth < 1000
      )
      SELECT 1 FROM chain WHERE start_id = parent_id LIMIT 1
    `),
  );
  if (cycles.length > 0) {
    throw new GraphQLError('A todo cannot be its own ancestor.', { extensions: { code: 'BAD_USER_INPUT' } });
  }
}

/**
 * A lane's success and failure routes point within its own board. Checked over
 * the caller's lanes after the write, like the other invariants here.
 */
async function assertRoutesInProject(tx: AnyTable, userId: string): Promise<void> {
  const stray = resultRows(
    await tx.execute(sql`
      SELECT 1 FROM lanes l JOIN lanes target ON target.id IN (l.on_success_lane_id, l.on_failure_lane_id)
      WHERE l.user_id = ${userId} AND target.project_id <> l.project_id
      LIMIT 1
    `),
  );
  if (stray.length === 0) return;
  throw new GraphQLError('A lane can only send todos to lanes on its own board.', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

/**
 * A project's new todos land on its own board. Checked after the write, over
 * the caller's projects, as a lane's routes are.
 */
async function assertNewTodoLaneInProject(tx: AnyTable, userId: string): Promise<void> {
  const stray = resultRows(
    await tx.execute(sql`
      SELECT 1 FROM projects p JOIN lanes l ON l.id = p.new_todo_lane_id
      WHERE p.user_id = ${userId} AND l.project_id <> p.id
      LIMIT 1
    `),
  );
  if (stray.length === 0) return;
  throw new GraphQLError("New todos can only land in a lane on the project's own board.", {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

/**
 * A lane that archives on a pass has no success route: one or the other.
 * Checked after the write, over the caller's lanes, so the message says what to
 * change rather than which constraint fired.
 */
async function assertArchiveOnSuccessFits(tx: AnyTable, userId: string): Promise<void> {
  const rows = resultRows<{ name: string }>(
    await tx.execute(sql`
      SELECT l.name FROM lanes l
      WHERE l.user_id = ${userId} AND l.archive_on_success AND l.on_success_lane_id IS NOT NULL
      LIMIT 1
    `),
  );
  if (rows.length === 0) return;
  const [lane] = rows;
  throw new GraphQLError(
    `"${lane.name}" can archive on success or have a success route to a lane, not both. Clear one of them.`,
    { extensions: { code: 'BAD_USER_INPUT' } },
  );
}

/**
 * Which lane means done is `setDoneLane`'s to decide: moving the flag has to
 * move the todos with it, and a generated write would leave the board saying one
 * thing and the list another.
 */
function assertDoneFlagUntouched(args: Parameters<typeof writtenRows>[0]): void {
  if (!writtenRows(args).some((row) => 'isDone' in row)) return;
  throw new GraphQLError('Use setDoneLane to choose which lane marks a todo done.', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

/** What a slug is made of: it is the prefix of every tool the server offers. */
const SERVER_SLUG = /^[A-Za-z0-9_-]+$/;
/** The slug of the board's own door, which every run has already. */
const TELOS_SLUG = 'telos';
const SLUG_CHARS = 60;

const isStrings = (value: unknown) => Array.isArray(value) && value.every((entry) => typeof entry === 'string');

/**
 * Whether an MCP server as written is one the runner could use. The table's
 * constraints say the same; this says it in words a form can show.
 */
async function assertServersSound(tx: AnyTable, userId: string, rows: Row[], inserting: boolean): Promise<void> {
  for (const row of rows) {
    const { slug, url, command } = row;
    if ('slug' in row) {
      if (typeof slug !== 'string' || slug.length > SLUG_CHARS || SERVER_SLUG.test(slug) === false) {
        throw badServer('A slug is letters, digits, dashes and underscores, such as "docs": tools are named under it.');
      }
      if (slug === TELOS_SLUG) {
        throw badServer(`"${TELOS_SLUG}" is the board's own tools, which every agent has. Pick another slug.`);
      }
    }
    if (typeof url === 'string') {
      const protocol = URL.canParse(url) ? new URL(url).protocol : '';
      if (protocol !== 'http:' && protocol !== 'https:') {
        throw badServer('The URL must be http or https.');
      }
    }
    if (inserting && typeof url !== 'string' && (typeof command !== 'string' || command.trim() === '')) {
      throw badServer('Give the server a URL or a command.');
    }
    for (const key of ['args', 'hiddenTools']) {
      if (key in row && isStrings(row[key]) === false) {
        throw badServer(`${key} is a list of strings.`);
      }
    }
    if ('hooks' in row && Array.isArray(row.hooks) === false) {
      throw badServer('hooks is a list.');
    }
    if ('cwd' in row && row.cwd !== null && (typeof row.cwd !== 'string' || row.cwd.trim() === '')) {
      throw badServer("A working directory is a path, or null for the runner's own.");
    }
    for (const [key, least] of [
      ['connectTimeoutMs', 1],
      ['callTimeoutMs', 1],
      ['idleTimeoutMs', 0],
    ] as const) {
      const value = row[key];
      if (key in row && value !== null && (Number.isInteger(value) === false || (value as number) < least)) {
        throw badServer(
          `${key} is a whole number of milliseconds, ${least} or more, or null for the runner's default.`,
        );
      }
    }
    if (inserting && typeof slug === 'string') {
      const taken = await tx.$count(
        dbSchema.mcpServers,
        and(eq(dbSchema.mcpServers.userId, userId), eq(dbSchema.mcpServers.slug, slug)),
      );
      if (taken > 0) {
        throw badServer(`You already have an MCP server with the slug "${slug}". Pick another.`);
      }
    }
  }
}

function badServer(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } });
}

/**
 * An agent's servers are absent (null: every server), or a list of slugs.
 * Anything else would be read as no list at all, which is every server.
 */
function assertServerListSound(rows: Row[]): void {
  for (const row of rows) {
    if ('mcpServerSlugs' in row && row.mcpServerSlugs !== null && isStrings(row.mcpServerSlugs) === false) {
      throw new GraphQLError('mcpServerSlugs is null for every server, or a list of slugs.', {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
  }
}

/**
 * An agent's tools for its runs are absent (null: a run's default), or a list
 * of the door's tools that are off. A name the door does not have would be a
 * switch that switches nothing, so it is refused, as `setApiKeyTools` refuses
 * it for a key.
 */
function assertRunToolsSound(rows: Row[]): void {
  for (const row of rows) {
    if (!('toolsOff' in row) || row.toolsOff === null) continue;
    if (isStrings(row.toolsOff) === false) {
      throw badServer("toolsOff is null for a run's default, or a list of the MCP door's tools.");
    }
    const unknown = (row.toolsOff as string[]).filter((name) => !DOOR_TOOL_NAMES.has(name));
    if (unknown.length > 0) {
      throw badServer(`The MCP door has no tool ${unknown.join(', ')}.`);
    }
    row.toolsOff = [...new Set(row.toolsOff as string[])];
  }
}

export const onWrite: NonNullable<BuildSchemaConfig['onWrite']> = {
  ...Object.fromEntries(
    Object.entries(FOREIGN_KEYS).map(([table, foreignKeys]) => [
      table,
      {
        before: async ({ args, context, tx }: WriteHookPayload) =>
          assertForeignKeysOwned(tx, context as Context, writtenRows(args), foreignKeys),
      },
    ]),
  ),
  lanes: {
    before: async ({ args, context, tx }: WriteHookPayload) => {
      assertDoneFlagUntouched(args);
      // Deleting a lane moves its todos (see `after`), which is history.
      await stampActor(tx, (context as Context).actor);
      await assertForeignKeysOwned(tx, context as Context, writtenRows(args), FOREIGN_KEYS.lanes);
    },
    // Deleting a lane sets its todos' `lane_id` to null, which can strand a
    // completed todo outside the done lane, and can empty a project's board
    // entirely. Re-asserted here for the same reason it is on todos: the
    // invariant, not the statement, is what must hold.
    after: async ({ args, context, tx }: WriteHookPayload) => {
      const userId = requireAuth(context as Context);
      if (states(args, 'onSuccessLaneId', 'onFailureLaneId')) await assertRoutesInProject(tx, userId);
      if (states(args, 'archiveOnSuccess', 'onSuccessLaneId')) await assertArchiveOnSuccessFits(tx, userId);
      await assertEveryProjectHasLanes(tx, userId);
      await realignLanes(tx, userId);
      await assertCompletionMatchesLane(tx, userId);
    },
  },
  agents: {
    before: async ({ args }: WriteHookPayload) => {
      assertServerListSound(writtenRows(args));
      assertRunToolsSound(writtenRows(args));
    },
  },
  mcpServers: {
    before: async ({ args, context, operation, tx }: WriteHookPayload) =>
      assertServersSound(tx, requireAuth(context as Context), writtenRows(args), operation === 'insert'),
  },
  projects: {
    before: async ({ args, context, operation, tx }: WriteHookPayload) => {
      assertAiSwitchUntouched(args);
      holdAiProjectWrite(args, context as Context, operation);
      await assertForeignKeysOwned(tx, context as Context, writtenRows(args), FOREIGN_KEYS.projects);
    },
    // A project without lanes has an empty board, so every project gets one at
    // the moment it is created — inside the creating transaction, so a project
    // never exists without it.
    after: async ({ args, context, operation, tx }: WriteHookPayload) => {
      const userId = requireAuth(context as Context);
      if (states(args, 'newTodoLaneId')) await assertNewTodoLaneInProject(tx, userId);
      if (operation !== 'insert') return;
      await seedMissingLanes(tx, userId);
    },
  },
  todos: {
    before: async ({ args, context, tx }: WriteHookPayload) => {
      assertIgnoreFlagFromPerson(args, context as Context);
      assertRunRequestUntouched(args);
      await assertForeignKeysOwned(tx, context as Context, writtenRows(args), FOREIGN_KEYS.todos);
      await stampActor(tx, (context as Context).actor);
    },
    // Checked after the statement rather than before it: a `where` may name the
    // affected rows by anything at all, so which todos a write completes is only
    // knowable once it has run. The returned rows cannot answer that either —
    // they carry only the columns the client selected — so the invariant is
    // re-asserted over the caller's todos instead. The throw rolls the
    // transaction back, statement included.
    after: async ({ args, context, operation, tx }: WriteHookPayload) => {
      if (operation === 'restore') return;
      // Archiving a todo stops whatever agent is working it. A hard delete
      // takes its runs with it.
      if (operation === 'delete') {
        if (!args.hard) await cancelRunsUnder(tx, { userId: requireAuth(context as Context), archivedTodos: true });
        return;
      }
      const created = operation === 'insert' || operation === 'upsert';
      const userId = requireAuth(context as Context);
      if (states(args, 'parentId')) await assertParentsSound(tx, userId);
      // Ignoring a todo stops whatever agent is working it.
      if (states(args, 'aiIgnored')) await cancelRunsUnder(tx, { userId, ignoredTodos: true });
      if (!created && !statesCompletion(args) && !statesLane(args)) return;
      if (marksComplete(args)) await assertNoBlockedCompletions(tx, userId);
      // A write that says what is done gets its lanes fixed to match; a write
      // that only names a lane is refused, because guessing which of the two the
      // caller meant would silently undo one of them.
      if (created || statesCompletion(args)) await realignLanes(tx, userId);
      await assertCompletionMatchesLane(tx, userId);
    },
  },
  todoNotes: {
    before: async ({ args, context, tx }: WriteHookPayload) => {
      assertPlainNotes(args);
      await assertForeignKeysOwned(tx, context as Context, writtenRows(args), FOREIGN_KEYS.todoNotes);
    },
  },
};
