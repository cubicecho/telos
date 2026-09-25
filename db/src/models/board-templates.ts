import { index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import type { LaneContract } from './lanes.ts';
import { users } from './users.ts';

/**
 * One lane of a saved board. Where a station sends its todos is kept as the
 * position of the lane it sends them to, since the lanes a template is applied
 * to are new ones with new ids.
 */
export interface TemplateLane {
  name: string;
  isDone: boolean;
  agentId?: string | null;
  contract?: LaneContract;
  prompt?: string | null;
  /** The index, in this template's lanes, of the lane a success goes to. */
  onSuccess?: number | null;
  /** The index of the lane a failure goes to. */
  onFailure?: number | null;
  wipLimit?: number;
  maxAttempts?: number;
}

// A board saved to start new projects from: its lanes, in order, and their
// station settings. Saved from a project (saveBoardTemplate) and applied to one
// that has no todos yet (applyBoardTemplate), which is where the lanes are
// checked, since a person may also edit a template's lanes directly.
export const boardTemplates = pgTable(
  'board_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    lanes: jsonb('lanes').$type<TemplateLane[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique('uq_board_templates_user_name').on(t.userId, t.name),
    index('idx_board_templates_user_id').on(t.userId),
  ],
);

export type BoardTemplate = typeof boardTemplates.$inferSelect;
export type NewBoardTemplate = typeof boardTemplates.$inferInsert;
