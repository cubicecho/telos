import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { createClient, createUser, type TestClient, type TestDb } from './helpers.ts';

// A board wired for agents, for the runner's tests: a user with AI on, a
// project with AI and auto-run on, and its first lane given an agent whose
// success route is Done. Everything goes through the API a person would use,
// so the setup itself exercises the generated agent and lane writes.

export interface Board {
  userId: string;
  /** The board's person, signed in, on an instance with AI on. */
  person: TestClient;
  projectId: string;
  /** To do (with the agent), In progress, Done. */
  lanes: Array<{ id: string; name: string; isDone: boolean }>;
  agentId: string;
  /** Adds a todo to the agent's lane. */
  addTodo: (title: string) => Promise<string>;
}

/** The runner, as the system principal. */
export function runnerClient(db: TestDb): TestClient {
  return createClient(db, null, { ai: true, actor: { kind: 'system', userId: null } });
}

/**
 * Builds a board with one lane that has an agent.
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
  await person.expectOk(SET_AUTO_RUN, { id: projectId, enabled: true });
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
  await setLane(person, lanes[0].id, { agentId, onSuccessLaneId: lanes[2].id });

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
 * Changes a lane's agent and routes as its person.
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

export const SET_AUTO_RUN = `mutation ($id: ID!, $enabled: Boolean!) {
  setProjectAutoRun(projectId: $id, enabled: $enabled) { id autoRun }
}`;
export const QUEUE = `query { runnerQueue { todoId laneId projectId } }`;
export const CLAIM = `mutation ($todoId: ID!, $laneId: ID!) {
  claimRun(todoId: $todoId, laneId: $laneId) {
    runId todoId token leaseExpiresAt
    agent { id name baseUrl model apiKey maxToolIterations mcpServers }
    brief { projectName projectContext laneName title brief acceptance report why notes }
  }
}`;
export const HEARTBEAT = `mutation ($id: ID!, $events: [RunEventInput!], $prompt: RunPromptInput, $usage: RunUsageInput) {
  heartbeatRun(id: $id, events: $events, prompt: $prompt, usage: $usage)
}`;
export const FINISH = `mutation ($id: ID!, $result: RunResultInput!) {
  finishRun(id: $id, result: $result) { id status verdict output error totalTokens }
}`;

export const START_DRAFT = `mutation ($projectId: ID!, $agentId: ID!, $message: String!) {
  startDraft(projectId: $projectId, agentId: $agentId, message: $message) { id waitingSince }
}`;
export const CLAIM_DRAFT = `mutation ($id: ID!) {
  claimDraft(id: $id) { draftId runId projectName projectContext title brief agent { id apiKey model } messages { role content } }
}`;
export const FINISH_DRAFT = `mutation (
  $id: ID!, $runId: ID, $reply: String, $title: String, $brief: String, $error: String,
  $prompt: RunPromptInput, $usage: RunUsageInput, $events: [RunEventInput!]
) {
  finishDraft(
    id: $id, runId: $runId, reply: $reply, title: $title, brief: $brief, error: $error,
    prompt: $prompt, usage: $usage, events: $events
  )
}`;

/** What a draft's agent spent on one reply, in the tests that count it. */
export const DRAFT_USAGE = { promptTokens: 40, completionTokens: 10, totalTokens: 50 };

/**
 * Starts a draft on a board and has the runner take it, leaving its reply
 * running.
 *
 * @param board - The board.
 * @param runner - The runner.
 * @returns The draft and the run answering it.
 */
export async function claimedDraft(board: Board, runner: TestClient): Promise<{ draftId: string; runId: string }> {
  const draftId = (
    await board.person.expectOk(START_DRAFT, {
      projectId: board.projectId,
      agentId: board.agentId,
      message: 'Make the export faster',
    })
  ).startDraft.id;
  const { runId } = (await runner.expectOk(CLAIM_DRAFT, { id: draftId })).claimDraft;
  return { draftId, runId };
}

/**
 * A draft on a board whose agent has answered once, or failed to.
 *
 * @param board - The board.
 * @param runner - The runner.
 * @param answer - What the runner reports: a reply, or an error.
 * @returns The draft and the finished run.
 */
export async function answeredDraft(
  board: Board,
  runner: TestClient,
  answer: Record<string, unknown> = { reply: 'Which export?', brief: 'Speed up the export.' },
): Promise<{ draftId: string; runId: string }> {
  const claimed = await claimedDraft(board, runner);
  await runner.expectOk(FINISH_DRAFT, { id: claimed.draftId, runId: claimed.runId, usage: DRAFT_USAGE, ...answer });
  return claimed;
}
