import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Board, createBoard, setLane } from './board.ts';
import { createClient, createTestDb, createUser, type TestDb } from './helpers.ts';

// Board templates: a board's lanes and station settings, saved and given to a
// new project.

let db: TestDb;
let board: Board;

const SAVE = `mutation ($projectId: ID!, $name: String!) { saveBoardTemplate(projectId: $projectId, name: $name) { id name lanes } }`;
const APPLY = `mutation ($projectId: ID!, $templateId: ID!) { applyBoardTemplate(projectId: $projectId, templateId: $templateId) { id } }`;
const LANES = `query ($projectId: UUID!) {
  lanes(where: { projectId: { eq: $projectId } }, orderBy: { position: { direction: asc, priority: 1 } }) {
    id name isDone agentId contract prompt onSuccessLaneId onFailureLaneId wipLimit maxAttempts
  }
}`;

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
});

async function newProject(person = board.person): Promise<string> {
  return (await person.expectOk(`mutation { createProject(values: { name: "Fresh" }) { id } }`)).createProject.id;
}

describe('board templates', () => {
  it('gives a new project the saved lanes, stations and routes', async () => {
    await setLane(board.person, board.lanes[1].id, { onFailureLaneId: board.lanes[0].id, wipLimit: 2, maxAttempts: 5 });
    const saved = (await board.person.expectOk(SAVE, { projectId: board.projectId, name: ' Pipeline ' }))
      .saveBoardTemplate;
    expect(saved.name).toBe('Pipeline');
    expect(saved.lanes).toHaveLength(3);
    expect(saved.lanes[0]).toMatchObject({ agentId: board.agentId, onSuccess: 2, prompt: 'Do the work.' });

    const projectId = await newProject();
    await board.person.expectOk(APPLY, { projectId, templateId: saved.id });
    const lanes = (await board.person.expectOk(LANES, { projectId })).lanes;
    expect(lanes.map((lane: { name: string }) => lane.name)).toEqual(board.lanes.map((lane) => lane.name));
    expect(lanes[0]).toMatchObject({ agentId: board.agentId, onSuccessLaneId: lanes[2].id, prompt: 'Do the work.' });
    expect(lanes[1]).toMatchObject({ onFailureLaneId: lanes[0].id, wipLimit: 2, maxAttempts: 5 });
    expect(lanes[2].isDone).toBe(true);
  });

  it('replaces a template of the same name', async () => {
    const first = (await board.person.expectOk(SAVE, { projectId: board.projectId, name: 'Mine' })).saveBoardTemplate;
    await setLane(board.person, board.lanes[1].id, { name: 'Doing' });
    const second = (await board.person.expectOk(SAVE, { projectId: board.projectId, name: 'Mine' })).saveBoardTemplate;
    expect(second.id).toBe(first.id);
    expect(second.lanes[1].name).toBe('Doing');
    expect((await board.person.expectError(SAVE, { projectId: board.projectId, name: '  ' })).code).toBe(
      'BAD_USER_INPUT',
    );
  });

  it('refuses a board that has todos, archived ones included', async () => {
    const template = (await board.person.expectOk(SAVE, { projectId: board.projectId, name: 'T' })).saveBoardTemplate;
    const todo = await board.addTodo('Here already');
    await db.update(dbSchema.todos).set({ archivedAt: new Date() }).where(eq(dbSchema.todos.id, todo));
    expect((await board.person.expectError(APPLY, { projectId: board.projectId, templateId: template.id })).code).toBe(
      'CONFLICT',
    );
  });

  it('refuses a template whose lanes do not make a board', async () => {
    const projectId = await newProject();
    const bad = async (lanes: unknown) => {
      const [row] = await db
        .insert(dbSchema.boardTemplates)
        .values({ userId: board.userId, name: `Bad ${Math.random()}`, lanes })
        .returning();
      return (await board.person.expectError(APPLY, { projectId, templateId: row.id })).code;
    };
    expect(await bad([])).toBe('BAD_USER_INPUT');
    expect(
      await bad([
        { name: 'A', isDone: true },
        { name: 'B', isDone: true },
      ]),
    ).toBe('BAD_USER_INPUT');
    expect(await bad([{ name: 'A', onSuccess: 3 }])).toBe('BAD_USER_INPUT');
    expect(await bad([{ name: 'A', contract: 'magic' }])).toBe('BAD_USER_INPUT');
    expect(await bad([{ name: 'A', wipLimit: 0 }])).toBe('BAD_USER_INPUT');
    // The board is as it was.
    expect((await board.person.expectOk(LANES, { projectId })).lanes).toHaveLength(3);
  });

  it('keeps to the caller’s own projects, templates and agents', async () => {
    const template = (await board.person.expectOk(SAVE, { projectId: board.projectId, name: 'T' })).saveBoardTemplate;
    const otherId = await createUser(db, 'other@example.com');
    const other = createClient(db, otherId, { ai: true });
    const theirs = await newProject(other);
    expect((await other.expectError(APPLY, { projectId: theirs, templateId: template.id })).code).toBe('NOT_FOUND');
    expect((await other.expectError(SAVE, { projectId: board.projectId, name: 'Stolen' })).code).toBe('NOT_FOUND');

    // A template naming someone else's agent leaves that lane a plain lane.
    const [row] = await db
      .insert(dbSchema.boardTemplates)
      .values({ userId: otherId, name: 'Borrowed', lanes: [{ name: 'A', agentId: board.agentId }] })
      .returning();
    await other.expectOk(APPLY, { projectId: theirs, templateId: row.id });
    const lanes = (await other.expectOk(LANES, { projectId: theirs })).lanes;
    expect(lanes).toEqual([expect.objectContaining({ name: 'A', agentId: null })]);
    const agents = await db.select().from(dbSchema.lanes).where(eq(dbSchema.lanes.agentId, board.agentId));
    expect(agents).toHaveLength(1);
  });
});
