import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import * as dbSchema from '@telos/db/schema';
import { eq } from 'drizzle-orm';

// Makes an account an admin, or stops it being one. Admins flip the instance's
// AI switch in Settings; the first account to sign up is one already, and this
// is how anyone else becomes one, since the app has no screen for it.
//
//   npm run admin -- --user <email> [--remove]

// biome-ignore lint/suspicious/noExplicitAny: db type varies by driver (postgres-js, PGlite)
type AnyDb = any;

/**
 * Sets an account's admin flag.
 *
 * @param db Telos's database.
 * @param email The account.
 * @param admin Whether it is to be an admin.
 * @returns Nothing; throws when there is no such account.
 */
export async function setAdmin(db: AnyDb, email: string, admin: boolean): Promise<void> {
  const updated = await db
    .update(dbSchema.users)
    .set({ isAdmin: admin })
    .where(eq(dbSchema.users.email, email.trim().toLowerCase()))
    .returning({ id: dbSchema.users.id });
  if (updated.length === 0) throw new Error(`No account with the address ${email}.`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      user: { type: 'string' },
      remove: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !values.user) {
    console.log(
      'Usage: npm run admin -- --user <email> [--remove]\n\n' +
        '  --user    the account, by email\n' +
        '  --remove  stop it being an admin instead',
    );
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  // Imported here, not at the top: `@telos/db` connects on import and demands
  // DATABASE_URL, which the tests (and --help) should not need.
  const { db } = await import('@telos/db');
  try {
    await setAdmin(db, values.user, !values.remove);
    console.log(`${values.user} is ${values.remove ? 'no longer' : 'now'} an admin.`);
  } finally {
    await db.$client?.end?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
