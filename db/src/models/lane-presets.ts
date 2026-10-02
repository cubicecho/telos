import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import type { LaneContract } from './lanes.ts';
import { users } from './users.ts';

/**
 * The lane columns a preset supplies, which a lane may override one by one
 * (`lanes.preset_overrides`). The prompt is not among them: a lane's own
 * prompt is added after its preset's, never in place of it.
 */
export const PRESET_FIELDS = ['contract', 'wipLimit', 'maxAttempts'] as const;
export type PresetField = (typeof PRESET_FIELDS)[number];

// A saved description of a lane's job: what makes a lane a station, apart from
// who works it. A lane made from one stays linked to it (`lanes.preset_id`),
// so editing the preset edits every lane that follows it, on every board.
//
// The link is kept true in the database, by the triggers in the lane_presets
// migration: a linked lane's columns always hold what a run is to go by (the
// preset's value, or the lane's own for a field it overrides), so everything
// that reads a lane reads it as before. Deleting a preset leaves its lanes,
// and the board templates that name it, with its values copied in.
export const lanePresets = pgTable(
  'lane_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    contract: text('contract').$type<LaneContract>().notNull().default('work'),
    // The job. A lane's own prompt comes after it.
    prompt: text('prompt'),
    wipLimit: integer('wip_limit').notNull().default(1),
    maxAttempts: integer('max_attempts').notNull().default(3),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique('uq_lane_presets_user_name').on(t.userId, t.name),
    index('idx_lane_presets_user_id').on(t.userId),
    check('ck_lane_presets_contract', sql`${t.contract} in ('work', 'verdict', 'expand')`),
    check('ck_lane_presets_wip_limit', sql`${t.wipLimit} > 0`),
    check('ck_lane_presets_max_attempts', sql`${t.maxAttempts} >= 0`),
  ],
);

export type LanePreset = typeof lanePresets.$inferSelect;
export type NewLanePreset = typeof lanePresets.$inferInsert;
