import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { createClient, createUser, type TestClient, type TestDb } from './helpers.ts';

// A board wired for agents, for the runner's tests: a user with AI on, a
// project with AI on, and its first lane made a station whose agent sends
// finished work to Done. Everything goes through the API a person would use,
// so the setup itself exercises the generated agent and lane writes.

export interface Board {
  userId: string;
  /** The board's person, signed in, on an instance with AI on. */
  person: TestClient;
  projectId: string;
  /** To do (the station), In progress, Done. */
  lanes: Array<{ id: string; name: string; isDone: boolean }>;
  agentId: string;
  /** Adds a todo to the station's lane. */
  addTodo: (title: string) => Promise<string>;
}

/** The runner, as the system principal. */
export function runnerClient(db: TestDb): TestClient {
  return createClient(db, null, { ai: true, actor: { kind: 'system', userId: null } });
}

/**
 * Builds a board with one station.
 *
 * @param db The test database.
 * @param email The board owner's address.
 * @returns The board.
 */
export async function createBoard(db: TestDb, email: string): Promise<Board> {
  const userId = await createUser(db, email);
  await db.update(dbSchema.users).set({ aiEnabled: true }).where(eq(dbSchema.users.id, userId));
  const person = createClient(db, userId, { ai: true });
  const projectId = (
    await person.expectOk(`mutation { createProject(values: { name: "P", context: "A test board." }) { id } }`)
  ).createProject.id;
  await person.expectOk(`mutation ($id: ID!) { setProjectAiEnabled(projectId: $id, enabled: true) { id } }`, {
    id: projectId,
  });
  const lanes = (
    await person.expectOk(
      `query ($projectId: UUID!) {
        lanes(where: { projectId: { eq: $projectId } }, orderBy: { position: { direction: asc, priority: 1 } }) { id name isDone }
      }`,
      { projectId },
    )
  ).lanes;
  const agentId = (
    await person.expectOk(
      `mutation { createAgent(values: { name: "Worker", baseUrl: "http://llm.test/v1", model: "tiny" }) { id } }`,
    )
  ).createAgent.id;
  await person.expectOk(`mutation ($id: ID!) { setAgentApiKey(agentId: $id, apiKey: "sk-secret") { id } }`, {
    id: agentId,
  });
  await setLane(person, lanes[0].id, { agentId, onSuccessLaneId: lanes[2].id, prompt: 'Do the work.' });

  const addTodo = async (title: string) =>
    (
      await person.expectOk(
        `mutation ($projectId: UUID!, $title: String!) { createTodo(values: { projectId: $projectId, title: $title }) { id } }`,
        { projectId, title },
      )
    ).createTodo.id as string;

  return { userId, person, projectId, lanes, agentId, addTodo };
}

/**
 * Changes a lane's station settings as its person.
 *
 * @param person The lane's owner.
 * @param id The lane.
 * @param set The columns to write.
 * @returns Nothing.
 */
export async function setLane(person: TestClient, id: string, set: Record<string, unknown>): Promise<void> {
  await person.expectOk(
    `mutation ($id: UUID!, $set: UpdateLaneInput!) { updateLane(set: $set, where: { id: { eq: $id } }) { id } }`,
    {
      id,
      set,
    },
  );
}

export const QUEUE = `query { runnerQueue { todoId laneId projectId } }`;
export const CLAIM = `mutation ($todoId: ID!, $laneId: ID!) {
  claimRun(todoId: $todoId, laneId: $laneId) {
    runId todoId token leaseExpiresAt
    agent { id name baseUrl model apiKey maxToolIterations mcpServers }
    brief { projectName projectContext laneName contract lanePrompt title brief acceptance report why notes }
  }
}`;
export const HEARTBEAT = `mutation ($id: ID!, $events: [RunEventInput!]) { heartbeatRun(id: $id, events: $events) }`;
export const FINISH = `mutation ($id: ID!, $result: RunResultInput!) {
  finishRun(id: $id, result: $result) { id status verdict output error totalTokens }
}`;
