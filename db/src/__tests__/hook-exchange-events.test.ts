import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// agent-mcp-pool 4 refuses a hook bound to beforeTurn or afterTurn, and the
// runner then drops every hook on that server. The migration renames them in
// the rows there already are; this runs it over a table with just the column.
const MIGRATION = readFileSync(
  new URL('../../drizzle/20261120034834_hook_exchange_events/migration.sql', import.meta.url),
  'utf8',
);

describe('the hook_exchange_events migration', () => {
  const db = new PGlite();

  beforeAll(async () => {
    await db.exec(`CREATE TABLE "mcp_servers" ("id" text PRIMARY KEY, "hooks" jsonb NOT NULL DEFAULT '[]'::jsonb)`);
    await db.query(`INSERT INTO "mcp_servers" ("id", "hooks") VALUES ($1, $2), ($3, $4), ($5, $6)`, [
      'old',
      JSON.stringify([
        { id: 'recall', on: 'beforeTurn', tool: 'recall', inject: true },
        { id: 'start', on: 'sessionStart', tool: 'open' },
        { id: 'file', on: 'afterTurn', tool: 'remember', enabled: false },
      ]),
      'new',
      JSON.stringify([{ id: 'recall', on: 'beforeExchange', tool: 'recall' }]),
      'none',
      '[]',
    ]);
    await db.exec(MIGRATION);
  });

  afterAll(() => db.close());

  const hooksOf = async (id: string) =>
    (await db.query<{ hooks: unknown }>(`SELECT "hooks" FROM "mcp_servers" WHERE "id" = $1`, [id])).rows[0].hooks;

  it('renames the old exchange events, keeping each hook and the order', async () => {
    expect(await hooksOf('old')).toEqual([
      { id: 'recall', on: 'beforeExchange', tool: 'recall', inject: true },
      { id: 'start', on: 'sessionStart', tool: 'open' },
      { id: 'file', on: 'afterExchange', tool: 'remember', enabled: false },
    ]);
  });

  it('leaves rows with nothing to rename as they were', async () => {
    expect(await hooksOf('new')).toEqual([{ id: 'recall', on: 'beforeExchange', tool: 'recall' }]);
    expect(await hooksOf('none')).toEqual([]);
  });
});
