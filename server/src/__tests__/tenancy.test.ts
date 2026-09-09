import * as dbSchema from '@telos/db/schema';
import { getTableName, is, Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { contextValues, scope } from '../tenancy.ts';

// The test that fails when someone adds a table and forgets tenancy. `scope` is
// what confines every generated read, update and delete to the caller; a table
// missing from it is readable across tenants, and nothing else in the codebase
// would say so.

const tableKeys = Object.entries(dbSchema)
  .filter(([, value]) => is(value, Table))
  .map(([key]) => key);

describe('tenancy configuration', () => {
  it('finds the tables', () => {
    expect(tableKeys.sort()).toEqual([
      'labels',
      'projectLabels',
      'projects',
      'todoDependencies',
      'todoLabels',
      'todos',
      'users',
    ]);
  });

  it.each(tableKeys)('scopes %s to the caller', (key) => {
    expect(scope[key]).toBeTypeOf('function');
  });

  it.each(tableKeys.filter((key) => key !== 'users'))('stamps userId on %s rather than accepting it', (key) => {
    expect(contextValues[key]?.userId).toBeTypeOf('function');
  });

  it('names every table by its Drizzle key, not its SQL name', () => {
    // scope is keyed by the schema export name; getting this wrong silently
    // scopes nothing, since an unknown key is simply never consulted.
    for (const [key, value] of Object.entries(dbSchema)) {
      if (!is(value, Table)) continue;
      expect(Object.keys(scope)).toContain(key);
      expect(getTableName(value)).toBeTypeOf('string');
    }
  });
});
