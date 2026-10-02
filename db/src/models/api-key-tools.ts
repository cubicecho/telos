import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';

import { apikeys } from './auth.ts';
import { users } from './users.ts';

// Which of the MCP door's tools an API key has switched off. A row per key that
// has ever had one changed; a key with no row has every tool on. The list is of
// tools that are off rather than on, so a tool added to the door later is on
// for every key there already is.
//
// Kept beside `apikeys` rather than in its `permissions` column: that table is
// better-auth's, and the plugin reads that column as its own. Written only by
// the server (`setApiKeyTools`) and read when a key is resolved (auth.ts), so
// it generates nothing.
export const apiKeyTools = pgTable(
  'api_key_tools',
  {
    keyId: uuid('key_id')
      .primaryKey()
      .references(() => apikeys.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Tool names, as the door lists them.
    off: jsonb('off').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_api_key_tools_user_id').on(t.userId)],
);

export type ApiKeyTools = typeof apiKeyTools.$inferSelect;
