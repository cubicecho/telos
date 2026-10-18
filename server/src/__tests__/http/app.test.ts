import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { assertObjectType, extendSchema, parse } from 'graphql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../http/app.ts';
import { createTestDb, hostFor, schemaFor, type TestDb } from '../helpers.ts';

// The real app over HTTP: what in-process `graphql()` cannot see — Yoga's
// error masking, the body cap, routing order and /healthz.

/** Past `HTTP_DEFAULTS.bodyLimit`, which is 1 MB. */
const OVERSIZED_PADDING_BYTES = 1_100_000;

let db: TestDb;
let server: Server;
let base: string;

beforeAll(async () => {
  db = await createTestDb();
  const { app } = createApp({
    db,
    authHost: hostFor(db),
    schema: schemaFor(db, false).schema,
    ai: false,
    version: '0',
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const post = (body: unknown) =>
  fetch(`${base}/graphql`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('the app over HTTP', () => {
  it('answers /healthz', async () => {
    const response = await fetch(`${base}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("keeps a coded error's code", async () => {
    const body = await (await post({ query: '{ projects { id } }' })).json();
    expect(body.errors[0].extensions.code).toBe('UNAUTHENTICATED');
  });

  it('masks an unexpected error, and logs its cause', async () => {
    // A field that fails the way a bug does: a plain Error, not a coded GraphQLError.
    const schema = extendSchema(schemaFor(db, false).schema, parse('extend type Query { boom: String }'));
    assertObjectType(schema.getType('Query')).getFields().boom.resolve = () => {
      throw new Error('the database password is hunter2');
    };
    const { app } = createApp({ db, authHost: hostFor(db), schema, ai: false, version: '0' });
    const boomServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => boomServer.once('listening', () => resolve()));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const url = `http://127.0.0.1:${(boomServer.address() as AddressInfo).port}/graphql`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ boom }' }),
      });
      const body = await response.json();
      expect(body.errors[0].message).toBe('Unexpected error.');
      expect(JSON.stringify(body)).not.toContain('hunter2');
      const lines = logged.mock.calls.map((call) => call.map(String).join(' '));
      expect(lines.some((line) => line.startsWith('[graphql]') && line.includes('hunter2'))).toBe(true);
    } finally {
      logged.mockRestore();
      await new Promise<void>((resolve) => boomServer.close(() => resolve()));
    }
  });

  it('rejects a body over the limit with 413', async () => {
    const response = await post({ query: '{ __typename }', variables: { pad: 'x'.repeat(OVERSIZED_PADDING_BYTES) } });
    expect(response.status).toBe(413);
  });
});
