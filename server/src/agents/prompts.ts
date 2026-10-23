import type { DB } from '@telos/db';
import { SEEDED_PROMPTS } from '@telos/db/prompt-seeds';
import * as dbSchema from '@telos/db/schema';

// The prompts an agent names to be told its job (`prompts`, `agents.promptId`).
// They are generated CRUD, a person's only (auth/rows.ts keeps AI out, and
// permissions.ts keeps generated writes a person's); what is here is the one
// thing CRUD cannot do: give a new account the prompts every account starts
// with. The text is db's (prompt-seeds.ts), which the prompts migration seeded
// the accounts there were then from.

export { DEFAULT_AGENT_INSTRUCTIONS, SEEDED_PROMPTS } from '@telos/db/prompt-seeds';

/**
 * Gives an account the seeded prompts it has not got, by name. Run when the
 * account is made (auth/better-auth.ts), so it never meets an empty list; a
 * name it already holds is left alone, so running it twice changes nothing.
 *
 * @param db - The database, or a transaction on it.
 * @param userId - Whose.
 */
export async function seedPrompts(db: Pick<DB, 'insert'>, userId: string): Promise<void> {
  await db
    .insert(dbSchema.prompts)
    .values(SEEDED_PROMPTS.map((seed) => ({ userId, name: seed.name, body: seed.body })))
    .onConflictDoNothing({ target: [dbSchema.prompts.userId, dbSchema.prompts.name] });
}
