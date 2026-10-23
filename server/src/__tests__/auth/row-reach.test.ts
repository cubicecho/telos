import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { defineAbilitiesFor } from '../../auth/abilities.ts';
import { ALL_TABLES, aiTodo, type RowSubject } from '../../auth/rows.ts';
import { conditionsSql, rowsReached } from '../../auth/sql-filter.ts';
import type { Actor } from '../../core/context.ts';
import { type Board, createBoard } from '../board.ts';
import { createClient, createTestDb, type TestClient, type TestDb } from '../helpers.ts';

// Which rows a caller reaches is the caller's ability's: one CASL rule per
// table, stated as conditions (auth/rows.ts), folded into SQL by
// auth/sql-filter.ts. Tenancy's scope and the hand-written lookups both run
// under it, so these hold the ability and the SQL it becomes; the generated
// reads' behaviour is held by the tenancy, MCP and owned tests.

let db: TestDb;
let board: Board;

const ZERO = '00000000-0000-0000-0000-000000000000';

beforeEach(async () => {
  db = await createTestDb({ instanceAi: true });
  board = await createBoard(db, 'owner@example.com');
});

/** The tables an actor's ability has a rule for. */
function tablesReached(actor: Actor): RowSubject[] {
  const ability = defineAbilitiesFor(actor);
  return ALL_TABLES.filter((table) => ability.rulesFor('read', table).length > 0);
}

/** The tables these tests read, by key. */
const TABLES = {
  users: dbSchema.users,
  projects: dbSchema.projects,
  lanes: dbSchema.lanes,
  todos: dbSchema.todos,
  todoNotes: dbSchema.todoNotes,
} as const;

/** The ids of a table's rows the actor reaches. */
async function idsReached(actor: Actor, subject: keyof typeof TABLES): Promise<string[]> {
  const table = TABLES[subject];
  const rows = await db
    .select({ id: table.id })
    .from(table)
    .where(rowsReached(defineAbilitiesFor(actor), db, subject, table));
  return rows.map((row: { id: string }) => row.id);
}

const person = (): Actor => ({ kind: 'user', userId: board.userId });
const key = (): Actor => ({ kind: 'apiKey', userId: board.userId, keyId: ZERO });

describe('the ability’s row rules', () => {
  it('give a person every table, its own rows only', async () => {
    expect(tablesReached(person())).toEqual([...ALL_TABLES]);
    expect(await idsReached(person(), 'projects')).toEqual([board.projectId]);
    expect(await idsReached(person(), 'users')).toEqual([board.userId]);
    const other = await createBoard(db, 'other@example.com');
    expect(await idsReached({ kind: 'user', userId: other.userId }, 'projects')).toEqual([other.projectId]);
  });

  it('give AI no agents or MCP servers, which hold secrets', () => {
    const reached = tablesReached(key());
    expect(reached).not.toContain('agents');
    expect(reached).not.toContain('mcpServers');
    expect(reached).toContain('todos');
  });

  it('give the runner and nobody no rows', () => {
    expect(tablesReached({ kind: 'system', userId: null })).toEqual([]);
    expect(tablesReached({ kind: 'anonymous', userId: null })).toEqual([]);
  });

  it('hide what hangs off a project with AI off, through the relation', async () => {
    const todoId = await board.addTodo('Work');
    expect(await idsReached(key(), 'lanes')).toHaveLength(board.lanes.length);
    expect(await idsReached(key(), 'todos')).toEqual([todoId]);

    await db.update(dbSchema.projects).set({ aiEnabled: false }).where(eq(dbSchema.projects.id, board.projectId));
    expect(await idsReached(key(), 'lanes')).toEqual([]);
    expect(await idsReached(key(), 'todos')).toEqual([]);
    expect(await idsReached(person(), 'todos')).toEqual([todoId]);
  });

  it('hide a note with its todo, two relations deep', async () => {
    const todoId = await board.addTodo('Work');
    const [note] = await db
      .insert(dbSchema.todoNotes)
      .values({ userId: board.userId, todoId, body: 'A note.' })
      .returning();
    expect(await idsReached(key(), 'todoNotes')).toEqual([note.id]);

    await db.update(dbSchema.todos).set({ aiIgnored: true }).where(eq(dbSchema.todos.id, todoId));
    expect(await idsReached(key(), 'todoNotes')).toEqual([]);
    expect(await idsReached(person(), 'todoNotes')).toEqual([note.id]);
  });
});

describe('conditions as SQL', () => {
  it('match what the conditions say, through a relation', async () => {
    const shown = await board.addTodo('Shown');
    const ignored = await board.addTodo('Ignored');
    await db.update(dbSchema.todos).set({ aiIgnored: true }).where(eq(dbSchema.todos.id, ignored));
    const rows = await db
      .select({ id: dbSchema.todos.id })
      .from(dbSchema.todos)
      .where(conditionsSql(db, dbSchema.todos, 'todos', aiTodo(board.userId)));
    expect(rows.map((row: { id: string }) => row.id)).toEqual([shown]);
  });

  it('read the operators CASL conditions use', async () => {
    const one = await board.addTodo('One');
    const two = await board.addTodo('Two');
    const ids = async (conditions: Record<string, unknown>) =>
      (
        await db
          .select({ id: dbSchema.todos.id })
          .from(dbSchema.todos)
          .where(conditionsSql(db, dbSchema.todos, 'todos', conditions))
      ).map((row: { id: string }) => row.id);
    expect(await ids({ id: { $in: [one] } })).toEqual([one]);
    expect(await ids({ id: { $nin: [one] } })).toEqual([two]);
    expect(await ids({ id: { $ne: one } })).toEqual([two]);
    expect(await ids({ id: { $in: [] } })).toEqual([]);
    expect(await ids({ archivedAt: null, title: 'Two' })).toEqual([two]);
  });

  it('refuse what they cannot translate, rather than widen', () => {
    expect(() => conditionsSql(db, dbSchema.todos, 'todos', { title: { $regex: 'x' } })).toThrow(/\$regex/);
    expect(() => conditionsSql(db, dbSchema.todos, 'todos', { 'owner.id': ZERO })).toThrow(/no relation owner/);
    expect(() => conditionsSql(db, dbSchema.todos, 'todos', { nope: 1 })).toThrow(/no column nope/);
  });
});

describe('AI callers of the todo mutations', () => {
  // AI reaches a todo only where AI may see it: not ignored, in a project with
  // AI on. Every mutation open to it answers NOT_FOUND past that, as its
  // generated reads do, and a person is untouched.

  let ai: TestClient;
  let hidden: string;

  beforeEach(async () => {
    ai = createClient(db, board.userId, { ai: true, actor: key() });
    hidden = await board.addTodo('Hidden');
    await db.update(dbSchema.todos).set({ aiIgnored: true }).where(eq(dbSchema.todos.id, hidden));
  });

  it('cannot answer, record against, or tie dependencies to an ignored todo', async () => {
    const visible = await board.addTodo('Visible');
    const calls: Array<[string, Record<string, unknown>]> = [
      ['mutation ($id: ID!) { answerTodo(todoId: $id, text: "Yes") { id } }', { id: hidden }],
      [
        'mutation ($id: ID!) { recordArtifact(todoId: $id, location: "https://x.test/a", label: "A") { id } }',
        { id: hidden },
      ],
      [
        'mutation ($id: ID!, $d: [ID!]!) { setTodoDependencies(id: $id, dependsOn: $d) { id } }',
        { id: visible, d: [hidden] },
      ],
      ['mutation ($id: ID!, $d: [ID!]!) { setTodoDependencies(id: $id, dependsOn: $d) { id } }', { id: hidden, d: [] }],
    ];
    for (const [source, variables] of calls) {
      expect((await ai.expectError(source, variables)).code).toBe('NOT_FOUND');
    }
    const edges = await db
      .select()
      .from(dbSchema.todoDependencies)
      .where(eq(dbSchema.todoDependencies.userId, board.userId));
    expect(edges).toEqual([]);
  });

  it('cannot delete an ignored todo, which a person still can', async () => {
    const remove = 'mutation ($id: UUID!) { deleteTodo(where: { id: { eq: $id } }) { id } }';
    expect((await ai.expectOk(remove, { id: hidden })).deleteTodo).toBeNull();
    const [row] = await db.select().from(dbSchema.todos).where(eq(dbSchema.todos.id, hidden));
    expect(row.archivedAt).toBeNull();
    expect((await board.person.expectOk(remove, { id: hidden })).deleteTodo).toEqual({ id: hidden });
  });
});
