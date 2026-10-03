import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appLink } from '../config.ts';
import { createClient, createTestDb, createUser, type TestClient } from './helpers.ts';

// A todo's `url` is how anything outside telos (a calendar's Today, a
// dashboard) links back to it. It names the todo and nothing else, so it keeps
// working when the todo moves to another project.

const CREATE_PROJECT = `mutation ($name: String!) { createProject(values: { name: $name }) { id url } }`;
const CREATE_TODO = `mutation ($projectId: UUID!) {
  createTodo(values: { projectId: $projectId, title: "Write it" }) { id url }
}`;
const MOVE = `mutation ($id: UUID!, $projectId: UUID!) {
  updateTodo(set: { projectId: $projectId }, where: { id: { eq: $id } }) { id url }
}`;

const saved = process.env.APP_URL;
let client: TestClient;

beforeEach(async () => {
  process.env.APP_URL = 'https://telos.example.com/';
  const db = await createTestDb();
  client = createClient(db, await createUser(db, 'owner@example.com'));
});

afterEach(() => {
  if (saved === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = saved;
});

describe('links into the app', () => {
  it('give a todo and a project a URL under APP_URL', async () => {
    const project = (await client.expectOk(CREATE_PROJECT, { name: 'P' })).createProject;
    const todo = (await client.expectOk(CREATE_TODO, { projectId: project.id })).createTodo;
    expect(project.url).toBe(`https://telos.example.com/projects/${project.id}`);
    expect(todo.url).toBe(`https://telos.example.com/todos/${todo.id}`);
  });

  it('keep a todo’s URL when it moves to another project', async () => {
    const first = (await client.expectOk(CREATE_PROJECT, { name: 'First' })).createProject;
    const second = (await client.expectOk(CREATE_PROJECT, { name: 'Second' })).createProject;
    const todo = (await client.expectOk(CREATE_TODO, { projectId: first.id })).createTodo;
    const moved = (await client.expectOk(MOVE, { id: todo.id, projectId: second.id })).updateTodo;
    expect(moved.url).toBe(todo.url);
  });
});

describe('appLink', () => {
  it('falls back to this server when APP_URL is unset', () => {
    delete process.env.APP_URL;
    expect(appLink('/todos/1')).toMatch(/^http:\/\/localhost:\d+\/todos\/1$/);
  });
});
