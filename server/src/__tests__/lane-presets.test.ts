import { randomUUID } from 'node:crypto';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Board, CLAIM, createBoard, runnerClient, setLane } from './board.ts';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// Lane presets: a station's contract, prompt and limits, kept on the account. A
// lane that follows one holds its values, except the fields it overrides, and
// adds its own prompt after the preset's.

let db: TestDb;
let board: Board;

const CREATE = `mutation ($values: CreateLanePresetInput!) {
  createLanePreset(values: $values) { id name contract prompt wipLimit maxAttempts }
}`;
const UPDATE = `mutation ($id: UUID!, $set: UpdateLanePresetInput!) {
  updateLanePreset(set: $set, where: { id: { eq: $id } }) { id name contract prompt wipLimit maxAttempts }
}`;
const DELETE = `mutation ($id: UUID!) { deleteLanePreset(where: { id: { eq: $id } }) { id } }`;
const PRESETS = `query { lanePresets { id name lanes { id name presetOverrides } } }`;
const LANE = `query ($id: UUID!) {
  lane(where: { id: { eq: $id } }) {
    id contract prompt wipLimit maxAttempts presetId presetOverrides preset { id name prompt }
  }
}`;
const SAVE_AS = `mutation ($laneId: ID!, $name: String!, $id: ID) {
  saveLaneAsPreset(laneId: $laneId, name: $name, id: $id) { id name contract prompt wipLimit maxAttempts }
}`;
const SAVE_TEMPLATE = `mutation ($projectId: ID!, $name: String!) {
  saveBoardTemplate(projectId: $projectId, name: $name) { id lanes }
}`;
const APPLY_TEMPLATE = `mutation ($projectId: ID!, $templateId: ID!) {
  applyBoardTemplate(projectId: $projectId, templateId: $templateId) { id }
}`;
const PROJECT_LANES = `query ($projectId: UUID!) {
  lanes(where: { projectId: { eq: $projectId } }, orderBy: { position: { direction: asc, priority: 1 } }) {
    id name contract prompt wipLimit maxAttempts presetId presetOverrides
  }
}`;

const REVIEW = { name: 'Review', contract: 'verdict', prompt: 'Judge it.', wipLimit: 2, maxAttempts: 4 };

beforeEach(async () => {
  db = await createTestDb();
  board = await createBoard(db, 'owner@example.com');
});

async function createPreset(values: Record<string, unknown> = REVIEW, person: TestClient = board.person) {
  return (await person.expectOk(CREATE, { values })).createLanePreset;
}

async function laneNow(id: string) {
  return (await board.person.expectOk(LANE, { id })).lane;
}

describe('a lane following a preset', () => {
  it('needs no preset', async () => {
    expect(await laneNow(board.lanes[0].id)).toMatchObject({
      presetId: null,
      presetOverrides: [],
      preset: null,
      prompt: 'Do the work.',
    });
  });

  it('takes the preset’s contract, WIP limit and attempts, and keeps its own prompt', async () => {
    const preset = await createPreset();
    await setLane(board.person, board.lanes[0].id, { presetId: preset.id });
    expect(await laneNow(board.lanes[0].id)).toMatchObject({
      contract: 'verdict',
      wipLimit: 2,
      maxAttempts: 4,
      prompt: 'Do the work.',
      presetOverrides: [],
      preset: { id: preset.id, name: 'Review', prompt: 'Judge it.' },
    });
  });

  it('follows an edit of the preset, but not in a field it overrides', async () => {
    const preset = await createPreset();
    await setLane(board.person, board.lanes[0].id, {
      presetId: preset.id,
      presetOverrides: ['wipLimit'],
      wipLimit: 7,
    });
    await board.person.expectOk(UPDATE, { id: preset.id, set: { contract: 'work', wipLimit: 3, maxAttempts: 1 } });
    expect(await laneNow(board.lanes[0].id)).toMatchObject({
      contract: 'work',
      wipLimit: 7,
      maxAttempts: 1,
      presetOverrides: ['wipLimit'],
    });
  });

  it('goes back to the preset’s value when an override is taken off', async () => {
    const preset = await createPreset();
    await setLane(board.person, board.lanes[0].id, {
      presetId: preset.id,
      presetOverrides: ['wipLimit', 'contract'],
      wipLimit: 7,
      contract: 'work',
    });
    await setLane(board.person, board.lanes[0].id, { presetOverrides: ['contract'] });
    expect(await laneNow(board.lanes[0].id)).toMatchObject({
      contract: 'work',
      wipLimit: 2,
      presetOverrides: ['contract'],
    });
  });

  it('treats a plain write of a followed field as the lane taking its own value', async () => {
    const preset = await createPreset();
    await setLane(board.person, board.lanes[0].id, { presetId: preset.id });
    await setLane(board.person, board.lanes[0].id, { maxAttempts: 9 });
    expect(await laneNow(board.lanes[0].id)).toMatchObject({ maxAttempts: 9, presetOverrides: ['maxAttempts'] });
    // Writing the value it already has changes nothing.
    await setLane(board.person, board.lanes[0].id, { wipLimit: 2 });
    expect((await laneNow(board.lanes[0].id)).presetOverrides).toEqual(['maxAttempts']);
    await board.person.expectOk(UPDATE, { id: preset.id, set: { maxAttempts: 1, wipLimit: 6 } });
    expect(await laneNow(board.lanes[0].id)).toMatchObject({ maxAttempts: 9, wipLimit: 6 });
  });

  it('keeps what it has, and forgets its overrides, when it stops following', async () => {
    const preset = await createPreset();
    await setLane(board.person, board.lanes[0].id, { presetId: preset.id, presetOverrides: ['wipLimit'], wipLimit: 7 });
    await setLane(board.person, board.lanes[0].id, { presetId: null });
    expect(await laneNow(board.lanes[0].id)).toMatchObject({
      presetId: null,
      presetOverrides: [],
      contract: 'verdict',
      wipLimit: 7,
      maxAttempts: 4,
    });
  });

  it('refuses overrides that are not a list of a preset’s fields', async () => {
    const preset = await createPreset();
    const set = (presetOverrides: unknown) =>
      board.person.expectError(
        `mutation ($id: UUID!, $set: UpdateLaneInput!) { updateLane(set: $set, where: { id: { eq: $id } }) { id } }`,
        { id: board.lanes[0].id, set: { presetId: preset.id, presetOverrides } },
      );
    expect((await set(['prompt'])).code).toBe('BAD_USER_INPUT');
    expect((await set('contract')).code).toBe('BAD_USER_INPUT');
    expect((await laneNow(board.lanes[0].id)).presetId).toBeNull();
  });

  it('is told the preset’s prompt and then its own', async () => {
    const preset = await createPreset();
    await setLane(board.person, board.lanes[0].id, { presetId: preset.id });
    const todoId = await board.addTodo('Check the export');
    const runner = runnerClient(db);
    const { brief } = (await runner.expectOk(CLAIM, { todoId, laneId: board.lanes[0].id })).claimRun;
    expect(brief).toMatchObject({ contract: 'verdict', lanePrompt: 'Judge it.\n\nDo the work.' });
  });

  it('is told only the preset’s prompt when it adds none', async () => {
    const preset = await createPreset();
    await setLane(board.person, board.lanes[0].id, { presetId: preset.id, prompt: null });
    const todoId = await board.addTodo('Check the export');
    const { brief } = (await runnerClient(db).expectOk(CLAIM, { todoId, laneId: board.lanes[0].id })).claimRun;
    expect(brief.lanePrompt).toBe('Judge it.');
  });

  it('cannot be turned by its preset into a station that archives its pieces', async () => {
    const preset = await createPreset();
    await setLane(board.person, board.lanes[0].id, {
      presetId: preset.id,
      onSuccessLaneId: null,
      archiveOnSuccess: true,
    });
    const refused = await board.person.expectError(UPDATE, { id: preset.id, set: { contract: 'expand' } });
    expect(refused.code).toBe('BAD_USER_INPUT');
    expect((await laneNow(board.lanes[0].id)).contract).toBe('verdict');

    // Nor by following one that already expands.
    const expand = await createPreset({ name: 'Break down', contract: 'expand' });
    expect(
      (
        await board.person.expectError(
          `mutation ($id: UUID!, $set: UpdateLaneInput!) { updateLane(set: $set, where: { id: { eq: $id } }) { id } }`,
          { id: board.lanes[0].id, set: { presetId: expand.id } },
        )
      ).code,
    ).toBe('BAD_USER_INPUT');
  });
});

describe('lane presets', () => {
  it('lists the lanes that follow each, and what they override', async () => {
    const preset = await createPreset();
    await createPreset({ name: 'Unused' });
    await setLane(board.person, board.lanes[0].id, { presetId: preset.id, presetOverrides: ['contract'] });
    await setLane(board.person, board.lanes[1].id, { presetId: preset.id });
    const { lanePresets } = await board.person.expectOk(PRESETS);
    const byName = Object.fromEntries(lanePresets.map((row: { name: string }) => [row.name, row]));
    expect(byName.Unused.lanes).toEqual([]);
    expect(byName.Review.lanes).toHaveLength(2);
    expect(byName.Review.lanes).toContainEqual({
      id: board.lanes[0].id,
      name: board.lanes[0].name,
      presetOverrides: ['contract'],
    });
  });

  it('takes a client’s id, and says what is wrong with a preset it refuses', async () => {
    const id = randomUUID();
    expect((await createPreset({ id, name: 'Mine' })).id).toBe(id);
    const refused = async (values: Record<string, unknown>) =>
      (await board.person.expectError(CREATE, { values })).code;
    expect(await refused({ name: 'Mine' })).toBe('CONFLICT');
    expect(await refused({ name: '  ' })).toBe('BAD_USER_INPUT');
    expect(await refused({ name: 'A', contract: 'magic' })).toBe('BAD_USER_INPUT');
    expect(await refused({ name: 'A', wipLimit: 0 })).toBe('BAD_USER_INPUT');
    expect(await refused({ name: 'A', maxAttempts: -1 })).toBe('BAD_USER_INPUT');

    const other = await createPreset({ name: 'Other' });
    expect((await board.person.expectError(UPDATE, { id: other.id, set: { name: 'Mine' } })).code).toBe('CONFLICT');
    // Saying its own name again is not a clash.
    await board.person.expectOk(UPDATE, { id: other.id, set: { name: 'Other', wipLimit: 3 } });
  });

  it('copies its values into the lanes that followed it when it is deleted', async () => {
    const preset = await createPreset();
    await setLane(board.person, board.lanes[0].id, { presetId: preset.id, presetOverrides: ['wipLimit'], wipLimit: 7 });
    await setLane(board.person, board.lanes[1].id, { presetId: preset.id });
    await board.person.expectOk(DELETE, { id: preset.id });

    expect(await laneNow(board.lanes[0].id)).toMatchObject({
      presetId: null,
      presetOverrides: [],
      contract: 'verdict',
      wipLimit: 7,
      maxAttempts: 4,
      prompt: 'Judge it.\n\nDo the work.',
    });
    expect(await laneNow(board.lanes[1].id)).toMatchObject({
      presetId: null,
      contract: 'verdict',
      wipLimit: 2,
      maxAttempts: 4,
      prompt: 'Judge it.',
    });
    // A lane that never followed it is as it was.
    expect((await laneNow(board.lanes[2].id)).prompt).toBeNull();
  });

  it('goes with its account, lanes and all', async () => {
    const preset = await createPreset();
    await setLane(board.person, board.lanes[0].id, { presetId: preset.id });
    await board.person.expectOk(SAVE_TEMPLATE, { projectId: board.projectId, name: 'T' });
    await db.delete(dbSchema.users).where(eq(dbSchema.users.id, board.userId));
    expect(await db.select().from(dbSchema.lanePresets)).toEqual([]);
    expect(await db.select().from(dbSchema.lanes)).toEqual([]);
  });
});

describe('saving a lane as a preset', () => {
  it('makes a preset of the lane and has the lane follow it', async () => {
    await setLane(board.person, board.lanes[0].id, { contract: 'verdict', wipLimit: 3, maxAttempts: 2 });
    const id = randomUUID();
    const preset = (await board.person.expectOk(SAVE_AS, { laneId: board.lanes[0].id, name: ' Checker ', id }))
      .saveLaneAsPreset;
    expect(preset).toEqual({
      id,
      name: 'Checker',
      contract: 'verdict',
      prompt: 'Do the work.',
      wipLimit: 3,
      maxAttempts: 2,
    });
    expect(await laneNow(board.lanes[0].id)).toMatchObject({
      presetId: id,
      presetOverrides: [],
      prompt: null,
      contract: 'verdict',
      wipLimit: 3,
      maxAttempts: 2,
    });
  });

  it('saves a lane that already follows one as what it is told now', async () => {
    const first = await createPreset();
    await setLane(board.person, board.lanes[0].id, { presetId: first.id, presetOverrides: ['wipLimit'], wipLimit: 7 });
    const second = (await board.person.expectOk(SAVE_AS, { laneId: board.lanes[0].id, name: 'Stricter' }))
      .saveLaneAsPreset;
    expect(second).toMatchObject({ contract: 'verdict', wipLimit: 7, prompt: 'Judge it.\n\nDo the work.' });
    expect(await laneNow(board.lanes[0].id)).toMatchObject({ presetId: second.id, presetOverrides: [], prompt: null });
  });

  it('refuses a name already taken, or none, and leaves the lane alone', async () => {
    await createPreset();
    expect((await board.person.expectError(SAVE_AS, { laneId: board.lanes[0].id, name: 'Review' })).code).toBe(
      'CONFLICT',
    );
    expect((await board.person.expectError(SAVE_AS, { laneId: board.lanes[0].id, name: ' ' })).code).toBe(
      'BAD_USER_INPUT',
    );
    expect(await laneNow(board.lanes[0].id)).toMatchObject({ presetId: null, prompt: 'Do the work.' });
  });
});

describe('a board template', () => {
  it('names a lane’s preset rather than copying it', async () => {
    const preset = await createPreset();
    await setLane(board.person, board.lanes[0].id, { presetId: preset.id, presetOverrides: ['wipLimit'], wipLimit: 7 });
    const template = (await board.person.expectOk(SAVE_TEMPLATE, { projectId: board.projectId, name: 'T' }))
      .saveBoardTemplate;
    expect(template.lanes[0]).toMatchObject({
      presetId: preset.id,
      presetOverrides: ['wipLimit'],
      prompt: 'Do the work.',
      wipLimit: 7,
    });
    expect(template.lanes[1]).toMatchObject({ presetId: null, presetOverrides: [] });

    // The preset is edited before the template is used: the new lanes get it
    // as it is now.
    await board.person.expectOk(UPDATE, { id: preset.id, set: { maxAttempts: 8, wipLimit: 5 } });
    const projectId = (await board.person.expectOk(`mutation { createProject(values: { name: "Fresh" }) { id } }`))
      .createProject.id;
    await board.person.expectOk(APPLY_TEMPLATE, { projectId, templateId: template.id });
    const { lanes } = await board.person.expectOk(PROJECT_LANES, { projectId });
    expect(lanes[0]).toMatchObject({
      presetId: preset.id,
      presetOverrides: ['wipLimit'],
      contract: 'verdict',
      wipLimit: 7,
      maxAttempts: 8,
      prompt: 'Do the work.',
    });
    expect(lanes[1].presetId).toBeNull();
  });

  it('gets a deleted preset’s values, so it builds the lanes it would have', async () => {
    const preset = await createPreset();
    await setLane(board.person, board.lanes[0].id, { presetId: preset.id, presetOverrides: ['wipLimit'], wipLimit: 7 });
    await setLane(board.person, board.lanes[1].id, { presetId: preset.id });
    const template = (await board.person.expectOk(SAVE_TEMPLATE, { projectId: board.projectId, name: 'T' }))
      .saveBoardTemplate;
    await board.person.expectOk(UPDATE, { id: preset.id, set: { maxAttempts: 8 } });
    await board.person.expectOk(DELETE, { id: preset.id });

    const [stored] = await db.select().from(dbSchema.boardTemplates).where(eq(dbSchema.boardTemplates.id, template.id));
    expect(stored.lanes).toHaveLength(3);
    expect(stored.lanes[0]).toMatchObject({
      name: board.lanes[0].name,
      contract: 'verdict',
      wipLimit: 7,
      maxAttempts: 8,
      prompt: 'Judge it.\n\nDo the work.',
      onSuccess: 2,
    });
    expect(stored.lanes[0]).not.toHaveProperty('presetId');
    expect(stored.lanes[0]).not.toHaveProperty('presetOverrides');
    expect(stored.lanes[1]).toMatchObject({ contract: 'verdict', wipLimit: 2, maxAttempts: 8, prompt: 'Judge it.' });
    expect(stored.lanes[2].name).toBe(board.lanes[2].name);

    const projectId = (await board.person.expectOk(`mutation { createProject(values: { name: "Fresh" }) { id } }`))
      .createProject.id;
    await board.person.expectOk(APPLY_TEMPLATE, { projectId, templateId: template.id });
    const { lanes } = await board.person.expectOk(PROJECT_LANES, { projectId });
    expect(lanes[0]).toMatchObject({
      presetId: null,
      contract: 'verdict',
      wipLimit: 7,
      maxAttempts: 8,
      prompt: 'Judge it.\n\nDo the work.',
    });
  });

  it('leaves a lane plain when the preset it names is someone else’s', async () => {
    const preset = await createPreset();
    const otherId = await createUser(db, 'other@example.com');
    const other = createClient(db, otherId, { ai: true });
    const projectId = (await other.expectOk(`mutation { createProject(values: { name: "Theirs" }) { id } }`))
      .createProject.id;
    const [template] = await db
      .insert(dbSchema.boardTemplates)
      .values({ userId: otherId, name: 'Borrowed', lanes: [{ name: 'A', presetId: preset.id, wipLimit: 4 }] })
      .returning();
    await other.expectOk(APPLY_TEMPLATE, { projectId, templateId: template.id });
    const [lane] = await db.select().from(dbSchema.lanes).where(eq(dbSchema.lanes.projectId, projectId));
    expect(lane).toMatchObject({ presetId: null, contract: 'work', wipLimit: 4 });
  });
});

describe('whose presets they are', () => {
  it('keeps a preset to its own account', async () => {
    const preset = await createPreset();
    const otherId = await createUser(db, 'other@example.com');
    const other = createClient(db, otherId, { ai: true });
    expect((await other.expectOk(PRESETS)).lanePresets).toEqual([]);
    // The same name is theirs to use.
    await createPreset({ name: 'Review' }, other);

    const theirProject = (await other.expectOk(`mutation { createProject(values: { name: "Theirs" }) { id } }`))
      .createProject.id;
    const [theirLane] = (await other.expectOk(PROJECT_LANES, { projectId: theirProject })).lanes;
    const follow = await other.expectError(
      `mutation ($id: UUID!, $set: UpdateLaneInput!) { updateLane(set: $set, where: { id: { eq: $id } }) { id } }`,
      { id: theirLane.id, set: { presetId: preset.id } },
    );
    expect(follow).toMatchObject({ code: 'NOT_FOUND', message: 'Lane preset not found' });

    await other.run(UPDATE, { id: preset.id, set: { wipLimit: 9 } });
    await other.run(DELETE, { id: preset.id });
    expect((await board.person.expectOk(PRESETS)).lanePresets).toEqual([
      expect.objectContaining({ id: preset.id, name: 'Review' }),
    ]);
    expect((await other.expectError(SAVE_AS, { laneId: board.lanes[0].id, name: 'Stolen' })).code).toBe('NOT_FOUND');
  });

  it('are not for AI to read or write', async () => {
    const preset = await createPreset();
    const agent = createClient(db, board.userId, {
      ai: true,
      actor: { kind: 'agent', userId: board.userId, runId: randomUUID() },
    });
    expect((await agent.expectOk(PRESETS)).lanePresets).toEqual([]);
    expect((await agent.expectError(CREATE, { values: { name: 'Sneaky' } })).code).toBe('FORBIDDEN');
    expect((await agent.expectError(DELETE, { id: preset.id })).code).toBe('FORBIDDEN');
    expect((await agent.expectError(SAVE_AS, { laneId: board.lanes[0].id, name: 'Sneaky' })).code).toBe('FORBIDDEN');
    expect((await runnerClient(db).expectError(SAVE_AS, { laneId: board.lanes[0].id, name: 'Sneaky' })).code).toBe(
      'FORBIDDEN',
    );
  });

  it('are not in the schema of an instance with AI off', async () => {
    const person = createClient(db, board.userId, { ai: false });
    const schema = await person.expectOk(`query {
      preset: __type(name: "LanePreset") { name }
      mutation: __type(name: "Mutation") { fields { name } }
      lane: __type(name: "Lane") { fields { name } }
    }`);
    const names = (type: { fields: Array<{ name: string }> }) => type.fields.map((field) => field.name);
    expect(schema.preset).toBeNull();
    expect(names(schema.mutation)).not.toContain('saveLaneAsPreset');
    expect(names(schema.lane)).not.toContain('presetId');
    expect(names(schema.lane)).not.toContain('presetOverrides');
    expect(names(schema.lane)).not.toContain('preset');
  });
});
