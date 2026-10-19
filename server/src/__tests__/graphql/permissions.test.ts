import { buildSchema, graphql, isObjectType } from 'graphql';
import { beforeAll, describe, expect, it } from 'vitest';
import { Audience, defineAbilitiesFor, mayCall, RootType } from '../../auth/abilities.ts';
import type { Actor, Context } from '../../core/context.ts';
import { applyCallerPermissions, permissionsFor, ROOT_FIELDS } from '../../graphql/permissions.ts';
import { createClient, createTestDb, createUser, schemaFor, type TestDb } from '../helpers.ts';

// The permissions map is the gate in front of every root field: who may call
// it at all, before tenancy decides which rows it reaches. It is deny by
// default, so these tests hold three things: the ability answers per caller
// kind, every field the server serves has been given an audience, and a field
// nobody gave one is refused to everyone.

const PERSON: Actor = { kind: 'user', userId: '00000000-0000-0000-0000-000000000001' };
const NOBODY: Actor = { kind: 'anonymous', userId: null };
const KEY: Actor = { kind: 'apiKey', userId: PERSON.userId, keyId: '00000000-0000-0000-0000-000000000002' };
const AGENT: Actor = { kind: 'agent', userId: PERSON.userId, runId: '00000000-0000-0000-0000-000000000003' };
const RUNNER: Actor = { kind: 'system', userId: null };

/** Whether `actor` may call a field of `root` meant for `audience`. */
const may = (actor: Actor, root: RootType, audience: Audience) =>
  mayCall(defineAbilitiesFor(actor), { root, name: 'anything', audience });

describe('defineAbilitiesFor', () => {
  it('lets a person, or nobody, call what is meant for a person, and not the runner’s', () => {
    for (const actor of [PERSON, NOBODY]) {
      expect(may(actor, RootType.Mutation, Audience.Person)).toBe(true);
      expect(may(actor, RootType.Mutation, Audience.PersonOrAi)).toBe(true);
      expect(may(actor, RootType.Query, Audience.Runner)).toBe(false);
      expect(may(actor, RootType.Mutation, Audience.Runner)).toBe(false);
    }
  });

  it('lets AI call only what is meant for a person or AI', () => {
    for (const actor of [KEY, AGENT]) {
      expect(may(actor, RootType.Query, Audience.PersonOrAi)).toBe(true);
      expect(may(actor, RootType.Mutation, Audience.PersonOrAi)).toBe(true);
      expect(may(actor, RootType.Query, Audience.Person)).toBe(false);
      expect(may(actor, RootType.Mutation, Audience.Person)).toBe(false);
      expect(may(actor, RootType.Mutation, Audience.Runner)).toBe(false);
    }
  });

  it('lets the runner call its own fields, and read', () => {
    expect(may(RUNNER, RootType.Mutation, Audience.Runner)).toBe(true);
    expect(may(RUNNER, RootType.Query, Audience.Runner)).toBe(true);
    expect(may(RUNNER, RootType.Query, Audience.Person)).toBe(true);
    expect(may(RUNNER, RootType.Mutation, Audience.Person)).toBe(false);
    expect(may(RUNNER, RootType.Mutation, Audience.PersonOrAi)).toBe(false);
  });
});

describe('the served schema', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb({ instanceAi: true });
  });

  it('gives every root field an audience, and names no field it does not have', () => {
    const { schema, entities } = schemaFor(db, true);
    const map = permissionsFor(schema, entities) as Record<string, Record<string, unknown>>;
    for (const root of Object.values(RootType)) {
      const type = schema.getType(root);
      if (!isObjectType(type)) throw new Error(`no ${root} type`);
      const fields = Object.keys(type.getFields());
      expect(fields.filter((name) => !(name in map[root]))).toEqual([]);
      const named = Object.values(ROOT_FIELDS[root]).flat();
      expect(named.filter((name) => !fields.includes(name))).toEqual([]);
    }
  });

  it('names each field once', () => {
    for (const root of Object.values(RootType)) {
      const named = Object.values(ROOT_FIELDS[root]).flat();
      expect(named.filter((name, index) => named.indexOf(name) !== index)).toEqual([]);
    }
  });

  it('builds with AI off, leaving the AI fields out', async () => {
    const off = await createTestDb();
    const { schema } = schemaFor(off, false);
    expect(schema.getQueryType()?.getFields().runnerQueue).toBeUndefined();
    const userId = await createUser(off, 'off@example.com');
    const data = await createClient(off, userId).expectOk(`mutation { createProject(values: { name: "P" }) { id } }`);
    expect(data.createProject.id).toBeTruthy();
  });

  it('refuses the runner’s fields to a person, and a person’s to AI and the runner', async () => {
    const userId = await createUser(db, 'person@example.com');
    const person = createClient(db, userId, { ai: true });
    const runnerQueue = await person.expectError(`query { runnerQueue { todoId } }`);
    expect(runnerQueue).toEqual({ code: 'FORBIDDEN', message: "runnerQueue is the runner's alone." });

    const key = createClient(db, userId, { ai: true, actor: { ...KEY, userId } });
    expect(await key.expectError(`query { agentDefaults { model } }`)).toEqual({
      code: 'FORBIDDEN',
      message: 'agentDefaults is not open to AI.',
    });

    const runner = createClient(db, null, { ai: true, actor: RUNNER });
    expect(await runner.expectError(`mutation { completeTodo(id: "${userId}") { id } }`)).toEqual({
      code: 'FORBIDDEN',
      message: 'completeTodo is not open to the runner.',
    });
  });

  it('lets nobody through to the field, which says UNAUTHENTICATED', async () => {
    const nobody = createClient(db, null, { ai: true });
    expect((await nobody.expectError(`query { agentDefaults { model } }`)).code).toBe('UNAUTHENTICATED');
    expect((await nobody.expectError(`mutation { completeTodo(id: "x") { id } }`)).code).toBe('UNAUTHENTICATED');
  });
});

describe('a root field nobody gave an audience', () => {
  const sdl = `
    type Query { authConfig: String, todos: String, unheardOf: String }
    type Mutation { claimRun: String, createTodo: String, mystery: String }
  `;

  /** A small schema with the map applied, `todos` and `createTodo` standing in for generated CRUD. */
  function guarded() {
    const schema = buildSchema(sdl);
    for (const type of [schema.getQueryType(), schema.getMutationType()]) {
      for (const field of Object.values(type?.getFields() ?? {})) {
        field.resolve = () => 'ran';
      }
    }
    return applyCallerPermissions(schema, { queries: { todos: {} }, mutations: { createTodo: {} } });
  }

  const run = (source: string, actor: Actor) =>
    graphql({ schema: guarded(), source, contextValue: { actor, ability: defineAbilitiesFor(actor) } as Context });

  it('is refused to every kind of caller, and the resolver never runs', async () => {
    for (const actor of [PERSON, NOBODY, KEY, AGENT, RUNNER]) {
      for (const source of ['query { unheardOf }', 'mutation { mystery }']) {
        const result = await run(source, actor);
        expect(result.data).toEqual({ [source.includes('mystery') ? 'mystery' : 'unheardOf']: null });
        expect(result.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
        expect(result.errors?.[0]?.message).toMatch(/is open to no one: say who it is for in ROOT_FIELDS/);
      }
    }
  });

  it('leaves the named fields to their audiences', async () => {
    expect((await run('query { authConfig todos }', PERSON)).data).toEqual({ authConfig: 'ran', todos: 'ran' });
    expect((await run('query { todos }', KEY)).data).toEqual({ todos: 'ran' });
    expect((await run('mutation { createTodo }', KEY)).data).toEqual({ createTodo: 'ran' });
    expect((await run('mutation { claimRun }', RUNNER)).data).toEqual({ claimRun: 'ran' });
    expect((await run('mutation { claimRun }', PERSON)).errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
  });
});
