import type { DB } from '@telos/db';
import { sql } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { QueryResolvers } from '../../__generated__/resolvers.ts';
import { aiAllowed } from '../ai/gate.ts';
import { requireAuth } from '../auth/resolvers.ts';
import { loadOwnedProject } from '../core/owned.ts';
import { attachResolvers } from '../graphql/attach-resolvers.ts';
import { failuresSinceTouched } from '../runs/ready.ts';
import { resultRows } from '../todos/blocking.ts';
import { openQuestion } from '../todos/questions.ts';

// What a board's cards say at a glance, for the whole board in one query: that
// a todo has notes, that its last run was sent back or never finished, how
// many attempts it has used, and the question its agent is waiting on. It carries no subscription of its own: the board
// refetches it when `boardChanged` says a note or a run was written.
//
// Notes are everyone's, so the query is there with AI off too. What runs left
// is read only while AI is on for the account and the project.

/** A reviewer ruled against the work: it was judged. */
export const MARK_REJECTED = 'rejected';
/** The run never finished its work: nothing was judged. */
export const MARK_ERRORED = 'errored';

const CARD_MARKS_SDL = parse(`
  "What a todo's card shows about its notes and its runs."
  type CardMark {
    todoId: ID!
    "How many notes a person or an outside client wrote on it. An agent's reports and verdicts are not counted."
    notes: Int!
    "How its last finished run ended, when it did not pass: rejected (a reviewer sent it back) or errored (it never finished). Null otherwise."
    lastRun: String
    "The reviewer's reason, or the error."
    reason: String
    "That run."
    runId: ID
    "Failed runs since a person last touched it, as aiStatus counts them."
    attempts: Int!
    "How many the lane it stands in allows before leaving it for a person. Null in a lane with no agent."
    maxAttempts: Int
    "What its agent asked a person and is waiting on, until a person answers. Null when nothing is."
    question: String
  }

  extend type Query {
    "The marks for a project's cards. Only todos with something to mark are listed, and archived ones never are."
    cardMarks(projectId: ID!): [CardMark!]!
  }
`);

interface MarkRow {
  todo_id: string;
  notes: number;
  run_id: string | null;
  status: string | null;
  verdict: string | null;
  reason: string | null;
  attempts: number;
  max_attempts: number | null;
  question: string | null;
}

/**
 * Reads a project's marks.
 *
 * @param db - The database or transaction.
 * @param userId - Whose project.
 * @param projectId - The project.
 * @param runs - Whether to read what runs left, or only the notes.
 * @returns A row for each todo with something to mark.
 */
async function readMarks(db: DB, userId: string, projectId: string, runs: boolean): Promise<MarkRow[]> {
  // A stopped run was called off, so it says nothing about the work, and a
  // running one has not ended: the last run that did is the one a card reports.
  const result = await db.execute(sql`
    SELECT m.* FROM (
      SELECT
        t.id AS todo_id, l.position AS lane_position, t.position, t.created_at,
        (
          SELECT count(*)::int FROM todo_notes n
          WHERE n.todo_id = t.id AND n.kind = 'note' AND n.actor_kind IN ('user', 'apiKey')
        ) AS notes,
        last.id AS run_id, last.status, last.verdict, coalesce(last.error, last.output) AS reason,
        CASE WHEN ${runs} THEN ${failuresSinceTouched(sql`t.id`)} ELSE 0 END AS attempts,
        CASE WHEN ${runs} AND l.agent_id IS NOT NULL THEN l.max_attempts END AS max_attempts,
        ${openQuestion(sql`t.id`)} AS question
      FROM todos t
      LEFT JOIN lanes l ON l.id = t.lane_id
      LEFT JOIN LATERAL (
        SELECT r.id, r.status, r.verdict, r.error, r.output FROM runs r
        WHERE r.todo_id = t.id AND r.status IN ('ok', 'error')
        ORDER BY r.started_at DESC LIMIT 1
      ) last ON ${runs}
      WHERE t.user_id = ${userId} AND t.project_id = ${projectId} AND t.archived_at IS NULL
    ) m
    WHERE m.notes > 0 OR m.attempts > 0 OR m.status = 'error' OR m.verdict = 'fail' OR m.question IS NOT NULL
    ORDER BY m.lane_position NULLS LAST, m.position, m.created_at
  `);
  return resultRows<MarkRow>(result);
}

/**
 * How a run that did not pass ended.
 *
 * @param row - The todo's last finished run, if it has one.
 * @returns The mark, or null when the run passed or there is none.
 */
function lastRunMark(row: MarkRow): string | null {
  if (row.status === 'error') {
    return MARK_ERRORED;
  }
  if (row.verdict === 'fail') {
    return MARK_REJECTED;
  }
  return null;
}

/**
 * Adds `cardMarks` to the schema.
 *
 * @param schema - The schema so far.
 * @param options - Whether the server offers AI at all.
 * @returns The schema with the marks query.
 */
export function applyCardMarksExtension(schema: GraphQLSchema, options: { ai: boolean }): GraphQLSchema {
  const extendedSchema = extendSchema(schema, CARD_MARKS_SDL);
  const queries: QueryResolvers = {};

  queries.cardMarks = async (_parent, args, context) => {
    // A person's, like the board it is drawn on.
    const userId = requireAuth(context);
    const db = context.db;
    const project = await loadOwnedProject(context, args.projectId);

    const runs = options.ai && project.aiEnabled && (await aiAllowed(context));
    const rows = await readMarks(db, userId, project.id, runs);
    return rows.map((row) => {
      const lastRun = lastRunMark(row);
      return {
        todoId: row.todo_id,
        notes: Number(row.notes),
        lastRun,
        reason: lastRun === null ? null : row.reason?.trim() || null,
        runId: lastRun === null ? null : row.run_id,
        attempts: Number(row.attempts),
        maxAttempts: row.max_attempts,
        question: row.question,
      };
    });
  };

  return attachResolvers(extendedSchema, { Query: queries });
}
