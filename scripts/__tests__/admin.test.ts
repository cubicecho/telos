import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createTestDb, createUser } from '../../server/src/__tests__/helpers.ts';
import { setAdmin } from '../admin.ts';

describe('setAdmin', () => {
  it('makes an account an admin by its address, and takes it away again', async () => {
    const db = await createTestDb();
    const userId = await createUser(db, 'someone@example.com');
    const isAdmin = async () =>
      (await db.select().from(dbSchema.users).where(eq(dbSchema.users.id, userId)))[0]?.isAdmin;

    await setAdmin(db, 'Someone@Example.com', true);
    expect(await isAdmin()).toBe(true);
    await setAdmin(db, 'someone@example.com', false);
    expect(await isAdmin()).toBe(false);
  });

  it('says so when there is no such account', async () => {
    const db = await createTestDb();
    await expect(setAdmin(db, 'nobody@example.com', true)).rejects.toThrow('No account');
  });
});
