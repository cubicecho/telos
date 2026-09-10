import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { projects } from './projects.ts';
import { users } from './users.ts';

// A board column. Lanes belong to a project, so two projects can describe their
// work differently without either one's vocabulary leaking into the other.
export const lanes = pgTable(
  'lanes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Ordering only, with no unique constraint: reordering rewrites several
    // lanes at once, and a unique index would reject the intermediate state.
    position: integer('position').notNull().default(0),
    // The lane that means "done". Dropping a todo here completes it and ticking
    // a todo's checkbox moves it here, so the board and the list never disagree.
    isDone: boolean('is_done').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_lanes_user_id').on(t.userId),
    index('idx_lanes_project_id').on(t.projectId),
    // At most one done lane per project — "done" has to name a single column
    // for the checkbox to know where to send a todo it ticks.
    uniqueIndex('uq_lanes_project_done').on(t.projectId).where(sql`is_done`),
  ],
);

export type Lane = typeof lanes.$inferSelect;
export type NewLane = typeof lanes.$inferInsert;
