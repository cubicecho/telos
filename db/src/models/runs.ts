import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { agents } from './agents.ts';
import { type LaneContract, lanes } from './lanes.ts';
import { projects } from './projects.ts';
import { todos } from './todos.ts';
import { users } from './users.ts';

/**
 * Where a run is. `running` holds a lease the runner keeps renewing; the rest
 * are final. `stopped` is a run somebody called off, which costs the todo no
 * attempt and moves it nowhere.
 */
export const RUN_STATUSES = ['running', 'ok', 'error', 'stopped'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** A verdict lane's ruling. `none` for every other kind of run. */
export const RUN_VERDICTS = ['none', 'pass', 'fail'] as const;
export type RunVerdict = (typeof RUN_VERDICTS)[number];

// One agent working one todo in one lane. Written only by the server — the
// runner claims, renews and finishes a run through resolvers/runs.ts, and a
// person can only ask for one to stop — so it is read-only through the API.
export const runs = pgTable(
  'runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    todoId: uuid('todo_id')
      .notNull()
      .references(() => todos.id, { onDelete: 'cascade' }),
    // `set null` for both: a run is history, and outlives the station it ran at.
    laneId: uuid('lane_id').references(() => lanes.id, { onDelete: 'set null' }),
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    // The lane's contract when the run was claimed, which is what its output is read against.
    contract: text('contract').$type<LaneContract>().notNull(),
    status: text('status').$type<RunStatus>().notNull().default('running'),
    verdict: text('verdict').$type<RunVerdict>().notNull().default('none'),
    output: text('output'),
    error: text('error'),
    toolCalls: integer('tool_calls').notNull().default(0),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    // A running run whose lease has passed is abandoned: its runner died.
    // The next claim of its todo marks it `error` and starts again.
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }).notNull(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_runs_user_id').on(t.userId),
    index('idx_runs_project_id').on(t.projectId),
    index('idx_runs_todo_id').on(t.todoId, t.startedAt),
    index('idx_runs_lane_id').on(t.laneId),
    index('idx_runs_agent_id').on(t.agentId),
    // One live run per todo. This is what makes two concurrent claims of the
    // same todo produce one winner rather than two agents doing the same work.
    uniqueIndex('uq_runs_todo_running').on(t.todoId).where(sql`status = 'running'`),
    check('ck_runs_status', sql`${t.status} in ('running', 'ok', 'error', 'stopped')`),
    check('ck_runs_verdict', sql`${t.verdict} in ('none', 'pass', 'fail')`),
    check('ck_runs_contract', sql`${t.contract} in ('work', 'verdict', 'expand')`),
  ],
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;
