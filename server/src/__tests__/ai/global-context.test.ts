import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Board, createBoard } from '../board.ts';
import { createClient, createTestDb, type TestDb } from '../helpers.ts';

// The account's global context and a project's context are both a person's to
// edit in Settings and AI's to keep up to date; the project prompt stays a
// person's (mcp.test.ts holds a key to that).

const SET = 'mutation ($context: String) { setGlobalContext(context: $context) { id globalContext } }';

let db: TestDb;
let board: Board;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
});

describe('the global context', () => {
  it('is written and read back by a person, trimmed, and cleared by a blank', async () => {
    expect((await board.person.expectOk('{ globalContext }')).globalContext).toBeNull();

    const set = await board.person.expectOk(SET, { context: '  Work runs on the homelab.\n' });
    expect(set.setGlobalContext).toEqual({ id: board.userId, globalContext: 'Work runs on the homelab.' });
    expect((await board.person.expectOk('{ globalContext }')).globalContext).toBe('Work runs on the homelab.');
    expect((await board.person.expectOk('{ users { globalContext } }')).users).toEqual([
      { globalContext: 'Work runs on the homelab.' },
    ]);

    await board.person.expectOk(SET, { context: '   ' });
    const [user] = await db.select().from(dbSchema.users).where(eq(dbSchema.users.id, board.userId));
    expect(user.globalContext).toBeNull();
  });

  it('is the account’s own: another account neither sees nor writes it', async () => {
    await board.person.expectOk(SET, { context: 'Mine.' });
    const other = await createBoard(db, 'other@example.com');
    expect((await other.person.expectOk('{ globalContext }')).globalContext).toBeNull();
    await other.person.expectOk(SET, { context: 'Theirs.' });
    expect((await board.person.expectOk('{ globalContext }')).globalContext).toBe('Mine.');
  });

  it('is not there while AI is off for the account', async () => {
    await db.update(dbSchema.users).set({ aiEnabled: false }).where(eq(dbSchema.users.id, board.userId));
    const person = createClient(db, board.userId, { ai: true });
    expect((await person.expectError('{ globalContext }')).code).toBe('NOT_FOUND');
    expect((await person.expectError(SET, { context: 'x' })).code).toBe('NOT_FOUND');
  });
});

describe("a project's context", () => {
  it('is a person’s to edit too', async () => {
    const updated = await board.person.expectOk(
      'mutation ($id: UUID!) { updateProject(set: { context: "A pnpm monorepo." }, where: { id: { eq: $id } }) { context } }',
      { id: board.projectId },
    );
    expect(updated.updateProject.context).toBe('A pnpm monorepo.');
  });
});
