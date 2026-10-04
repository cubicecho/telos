import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { agents } from './agents.ts';
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
    // The agent that works this lane's todos: the runner hands it each todo
    // that arrives here, and what to do with it is in the agent's own
    // instructions. Everything below means nothing without one, and nothing at
    // all while the project's AI is off.
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    // The success and failure routes: where a todo goes when its run passes or
    // fails. Neither set, and the todo stays where it is.
    onSuccessLaneId: uuid('on_success_lane_id').references((): AnyPgColumn => lanes.id, { onDelete: 'set null' }),
    onFailureLaneId: uuid('on_failure_lane_id').references((): AnyPgColumn => lanes.id, { onDelete: 'set null' }),
    // What a pass does instead of following the success route: completes the
    // todo and archives it, for a pipeline whose finished work nobody needs to
    // see in a column. One or the other, held by the lane write guard.
    archiveOnSuccess: boolean('archive_on_success').notNull().default(false),
    // How many of this lane's todos may be worked at once.
    wipLimit: integer('wip_limit').notNull().default(1),
    // How many failures a todo may have here before the agent stops picking
    // it up and leaves it for a person. The count starts over whenever a
    // person moves it.
    maxAttempts: integer('max_attempts').notNull().default(3),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_lanes_user_id').on(t.userId),
    index('idx_lanes_project_id').on(t.projectId),
    index('idx_lanes_agent_id').on(t.agentId),
    index('idx_lanes_on_success_lane_id').on(t.onSuccessLaneId),
    index('idx_lanes_on_failure_lane_id').on(t.onFailureLaneId),
    check('ck_lanes_wip_limit', sql`${t.wipLimit} > 0`),
    check('ck_lanes_max_attempts', sql`${t.maxAttempts} >= 0`),
    // At most one done lane per project — "done" has to name a single column
    // for the checkbox to know where to send a todo it ticks.
    uniqueIndex('uq_lanes_project_done').on(t.projectId).where(sql`is_done`),
  ],
);

export type Lane = typeof lanes.$inferSelect;
export type NewLane = typeof lanes.$inferInsert;
