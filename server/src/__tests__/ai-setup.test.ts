import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLAIM, CLAIM_DRAFT, FINISH_DRAFT, QUEUE, runnerClient, SET_AUTO_RUN, START_DRAFT, setLane } from './board.ts';
import { createClient, createTestDb, createUser, type TestClient, type TestDb } from './helpers.ts';

// What is in place for a first run, read back a step at a time.

const SETUP = `query { aiSetup { agent station stationProjectIds projectAi request started runnerSeenAt } }`;
const NOTHING = {
  agent: false,
  station: false,
  stationProjectIds: [],
  projectAi: false,
  request: false,
  started: false,
};

let db: TestDb;
let userId: string;
let person: TestClient;

beforeEach(async () => {
  db = await createTestDb();
  userId = await createUser(db, 'owner@example.com');
  await db.update(dbSchema.users).set({ aiEnabled: true }).where(eq(dbSchema.users.id, userId));
  person = createClient(db, userId, { ai: true });
});

// biome-ignore lint/suspicious/noExplicitAny: response shape
async function setup(client: TestClient = person): Promise<any> {
  return (await client.expectOk(SETUP)).aiSetup;
}

async function createProject(name: string): Promise<{ id: string; lanes: Array<{ id: string }> }> {
  const { id } = (
    await person.expectOk(`mutation ($name: String!) { createProject(values: { name: $name }) { id } }`, { name })
  ).createProject;
  const { lanes } = await person.expectOk(
    `query ($id: UUID!) {
      lanes(where: { projectId: { eq: $id } }, orderBy: { position: { direction: asc, priority: 1 } }) { id }
    }`,
    { id },
  );
  return { id, lanes };
}

async function createAgent(): Promise<string> {
  return (
    await person.expectOk(
      `mutation { createAgent(values: { name: "Worker", baseUrl: "http://llm.test/v1", model: "tiny" }) { id } }`,
    )
  ).createAgent.id;
}

async function addTodo(projectId: string): Promise<string> {
  return (
    await person.expectOk(
      `mutation ($projectId: UUID!) { createTodo(values: { projectId: $projectId, title: "T" }) { id } }`,
      { projectId },
    )
  ).createTodo.id;
}

const SET_PROJECT_AI = `mutation ($id: ID!, $enabled: Boolean!) { setProjectAiEnabled(projectId: $id, enabled: $enabled) { id } }`;

describe('aiSetup', () => {
  it('has nothing in place for a new account', async () => {
    await createProject('P');
    expect(await setup()).toMatchObject(NOTHING);
  });

  it('ticks each step as it is taken', async () => {
    const project = await createProject('P');
    const agentId = await createAgent();
    expect(await setup()).toMatchObject({ ...NOTHING, agent: true });

    await setLane(person, project.lanes[0].id, { agentId });
    expect(await setup()).toMatchObject({ ...NOTHING, agent: true, station: true, stationProjectIds: [project.id] });

    await person.expectOk(SET_PROJECT_AI, { id: project.id, enabled: true });
    expect(await setup()).toMatchObject({ station: true, projectAi: true, request: false, started: false });

    const todoId = await addTodo(project.id);
    expect(await setup()).toMatchObject({ projectAi: true, request: true, started: false });

    await person.expectOk(`mutation ($id: ID!) { runTodo(id: $id) { id } }`, { id: todoId });
    expect(await setup()).toMatchObject({ request: true, started: true });
  });

  it('counts a project that runs by itself as started', async () => {
    const project = await createProject('P');
    await setLane(person, project.lanes[0].id, { agentId: await createAgent() });
    await person.expectOk(SET_PROJECT_AI, { id: project.id, enabled: true });
    await person.expectOk(SET_AUTO_RUN, { id: project.id, enabled: true });
    expect(await setup()).toMatchObject({ projectAi: true, request: false, started: true });
  });

  it('stays started after the asked-for todo has been taken, because a run was made', async () => {
    const project = await createProject('P');
    await setLane(person, project.lanes[0].id, { agentId: await createAgent() });
    await person.expectOk(SET_PROJECT_AI, { id: project.id, enabled: true });
    const todoId = await addTodo(project.id);
    await person.expectOk(`mutation ($id: ID!) { runTodo(id: $id) { id } }`, { id: todoId });
    await runnerClient(db).expectOk(CLAIM, { todoId, laneId: project.lanes[0].id });
    expect(await setup()).toMatchObject({ request: true, started: true });
  });

  it('does not count a todo outside a station, or one AI is told to ignore', async () => {
    const project = await createProject('P');
    await setLane(person, project.lanes[1].id, { agentId: await createAgent() });
    await person.expectOk(SET_PROJECT_AI, { id: project.id, enabled: true });
    const todoId = await addTodo(project.id);
    expect((await setup()).request).toBe(false);

    await person.expectOk(`mutation ($id: ID!, $laneId: ID!) { moveTodo(id: $id, laneId: $laneId) { id } }`, {
      id: todoId,
      laneId: project.lanes[1].id,
    });
    expect((await setup()).request).toBe(true);

    await person.expectOk(
      `mutation ($id: UUID!) { updateTodo(set: { aiIgnored: true }, where: { id: { eq: $id } }) { id } }`,
      { id: todoId },
    );
    expect((await setup()).request).toBe(false);
  });

  it('counts a draft as a first request', async () => {
    const project = await createProject('P');
    const agentId = await createAgent();
    await person.expectOk(SET_PROJECT_AI, { id: project.id, enabled: true });
    await person.expectOk(
      `mutation ($projectId: ID!, $agentId: ID!) { startDraft(projectId: $projectId, agentId: $agentId, message: "Hello") { id } }`,
      { projectId: project.id, agentId },
    );
    expect(await setup()).toMatchObject({ station: false, request: true });
  });

  it('does not count a draft’s reply as a station having started', async () => {
    const project = await createProject('P');
    const agentId = await createAgent();
    await person.expectOk(SET_PROJECT_AI, { id: project.id, enabled: true });
    const draftId = (await person.expectOk(START_DRAFT, { projectId: project.id, agentId, message: 'Hello' }))
      .startDraft.id;
    const runner = runnerClient(db);
    const { runId } = (await runner.expectOk(CLAIM_DRAFT, { id: draftId })).claimDraft;
    await runner.expectOk(FINISH_DRAFT, { id: draftId, runId, reply: 'Hi.' });
    // The reply is a run, but no station made it.
    expect(await db.$count(dbSchema.runs)).toBe(1);
    expect(await setup()).toMatchObject({ request: true, started: false });
  });

  it('links to the project furthest along, and leaves archived ones out', async () => {
    const agentId = await createAgent();
    const first = await createProject('First');
    const second = await createProject('Second');
    await setLane(person, first.lanes[0].id, { agentId });
    await setLane(person, second.lanes[0].id, { agentId });
    expect((await setup()).stationProjectIds).toEqual([first.id, second.id]);

    await person.expectOk(SET_PROJECT_AI, { id: second.id, enabled: true });
    expect((await setup()).stationProjectIds).toEqual([second.id, first.id]);

    await db.update(dbSchema.projects).set({ archivedAt: new Date() }).where(eq(dbSchema.projects.id, second.id));
    expect(await setup()).toMatchObject({ stationProjectIds: [first.id], projectAi: false });
  });

  it("reads only the caller's own", async () => {
    const project = await createProject('P');
    await setLane(person, project.lanes[0].id, { agentId: await createAgent() });
    const otherId = await createUser(db, 'other@example.com');
    await db.update(dbSchema.users).set({ aiEnabled: true }).where(eq(dbSchema.users.id, otherId));
    expect(await setup(createClient(db, otherId, { ai: true }))).toMatchObject(NOTHING);
  });

  it('says when the runner last asked for work', async () => {
    await runnerClient(db).expectOk(QUEUE);
    const seen = (await setup()).runnerSeenAt;
    expect(Date.now() - new Date(seen).getTime()).toBeLessThan(5000);
  });

  it('is not there for an account with AI off', async () => {
    await db.update(dbSchema.users).set({ aiEnabled: false }).where(eq(dbSchema.users.id, userId));
    expect(await person.expectError(SETUP)).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('is not in the schema when the server offers no AI', async () => {
    const result = await createClient(db, userId).run(SETUP);
    expect(result.errors?.[0]?.message).toContain('aiSetup');
  });
});
