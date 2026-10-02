import * as dbSchema from '@telos/db/schema';
import { eq, sql } from 'drizzle-orm';
import { extendSchema, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi } from '../ai-gate.ts';
import { resultRows } from '../blocking.ts';
import type { Context } from '../context.ts';
import { failuresSinceTouched } from '../stations.ts';
import { requireSession } from './auth.ts';

// What an account's agents did and spent, across every project it owns: the
// two things the generated lists cannot say. Spend is the runs of a window
// added up by project and by agent, with where the window really starts when
// retention has trimmed it. Attention is the todos a station gave up on or
// whose last run never finished.
//
// The runs, artifacts and archived todos themselves come from the generated
// queries, which are already the account's own.
//
// Applied only when the instance has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

/** What a run whose agent was deleted is filed under. */
export const DELETED_AGENT = 'A deleted agent';

const DAY_MS = 24 * 60 * 60_000;

const ACCOUNT_ACTIVITY_SDL = parse(`
  "What one project's or one agent's runs spent in a window."
  type SpendLine {
    "The project or the agent. Null for runs whose agent was deleted."
    id: ID
    name: String!
    "Every run, a draft's replies among them."
    runs: Int!
    "How many of them were replies in drafts."
    draftReplies: Int!
    promptTokens: Float!
    completionTokens: Float!
    totalTokens: Float!
  }

  "What an account's runs spent since a moment."
  type AccountSpend {
    since: DateTime!
    "Where the window really starts, when run retention has deleted the runs before it. Null when the whole window is kept."
    keptSince: DateTime
    "How many days the account keeps a finished run. Null is for good."
    retentionDays: Int
    total: SpendLine!
    "Each project with a run in the window, the most spent first."
    byProject: [SpendLine!]!
    "Each agent with a run in the window, the most spent first."
    byAgent: [SpendLine!]!
  }

  "A todo waiting on a person because of how its runs went."
  type AttentionTodo {
    todoId: ID!
    title: String!
    projectId: ID!
    projectName: String!
    laneId: ID
    laneName: String
    "Its station has used every attempt its lane allows."
    outOfAttempts: Boolean!
    "Its last finished run never finished its work."
    errored: Boolean!
    "The error, or the reviewer's reason, of its last failed run."
    reason: String
    "Its last finished run."
    runId: ID
    "Failed runs since a person last touched it, as aiStatus counts them."
    attempts: Int!
    "How many its lane allows. Null outside a station."
    maxAttempts: Int
  }

  extend type Query {
    "What your runs spent since a moment, across every project, by project and by agent."
    accountSpend(since: DateTime!): AccountSpend!
    "Your open todos, across your AI projects, that are out of attempts or whose last run errored."
    accountAttention: [AttentionTodo!]!
  }
`);

interface SpendRow {
  id: string | null;
  name: string | null;
  runs: number;
  draft_replies: number;
  prompt_tokens: string | number;
  completion_tokens: string | number;
  total_tokens: string | number;
}

interface AttentionRow {
  todo_id: string;
  title: string;
  project_id: string;
  project_name: string;
  lane_id: string | null;
  lane_name: string | null;
  run_id: string | null;
  errored: boolean;
  reason: string | null;
  attempts: number;
  max_attempts: number | null;
}

/** The columns every spend row has, over runs named `r`. */
const SPEND_SUMS = sql`
  count(*)::int AS runs,
  count(*) FILTER (WHERE r.kind = 'draft')::int AS draft_replies,
  coalesce(sum(r.prompt_tokens), 0) AS prompt_tokens,
  coalesce(sum(r.completion_tokens), 0) AS completion_tokens,
  coalesce(sum(r.total_tokens), 0) AS total_tokens
`;

/**
 * A spend row as the API returns it. A sum comes back from Postgres as text.
 *
 * @param row - The row.
 * @param name - What to call it when it has no name of its own.
 * @returns The line.
 */
function spendLine(row: SpendRow | undefined, name: string) {
  return {
    id: row?.id ?? null,
    name: row?.name ?? name,
    runs: Number(row?.runs ?? 0),
    draftReplies: Number(row?.draft_replies ?? 0),
    promptTokens: Number(row?.prompt_tokens ?? 0),
    completionTokens: Number(row?.completion_tokens ?? 0),
    totalTokens: Number(row?.total_tokens ?? 0),
  };
}

/**
 * Adds `accountSpend` and `accountAttention` to the schema.
 *
 * @param schema - The schema so far.
 * @returns The schema with the account's activity queries.
 */
export function applyAccountActivityExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, ACCOUNT_ACTIVITY_SDL);
  const queries = (extendedSchema.getType('Query') as GraphQLObjectType).getFields();

  queries.accountSpend.resolve = async (_parent: unknown, args: { since: Date | string }, context: Context) => {
    // A person's, like the page it is drawn on.
    requireSession(context);
    const userId = await requireAi(context);
    const db = context.db as AnyRow;
    const since = new Date(args.since);
    const window = sql`r.user_id = ${userId} AND r.started_at >= ${since.toISOString()}::timestamptz`;

    const [total] = resultRows<SpendRow>(
      await db.execute(sql`SELECT NULL AS id, NULL AS name, ${SPEND_SUMS} FROM runs r WHERE ${window}`),
    );
    // Every project the account owns, archived and AI-off ones too: what was
    // spent there was still spent.
    const byProject = resultRows<SpendRow>(
      await db.execute(sql`
        SELECT p.id, p.name, ${SPEND_SUMS}
        FROM runs r JOIN projects p ON p.id = r.project_id
        WHERE ${window}
        GROUP BY p.id, p.name
        ORDER BY total_tokens DESC, runs DESC, p.name
      `),
    );
    const byAgent = resultRows<SpendRow>(
      await db.execute(sql`
        SELECT a.id, a.name, ${SPEND_SUMS}
        FROM runs r LEFT JOIN agents a ON a.id = r.agent_id
        WHERE ${window}
        GROUP BY a.id, a.name
        ORDER BY total_tokens DESC, runs DESC, a.name
      `),
    );

    const [user] = await db
      .select({ runRetentionDays: dbSchema.users.runRetentionDays })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.id, userId));
    const retentionDays: number | null = user?.runRetentionDays ?? null;
    // Pruning keeps the few old runs a station still counts, so this is where
    // the full record starts rather than the oldest run there is.
    const kept = retentionDays === null ? null : new Date(Date.now() - retentionDays * DAY_MS);

    return {
      since,
      keptSince: kept !== null && kept > since ? kept : null,
      retentionDays,
      total: spendLine(total, 'Every project'),
      byProject: byProject.map((row) => spendLine(row, 'A project')),
      byAgent: byAgent.map((row) => spendLine(row, DELETED_AGENT)),
    };
  };

  queries.accountAttention.resolve = async (_parent: unknown, _args: unknown, context: Context) => {
    requireSession(context);
    const userId = await requireAi(context);
    const db = context.db as AnyRow;
    // The open todos `aiStatus` reads, less the ones AI is told to leave and
    // the ones an agent is on now. Runs are found by todo, so a draft's
    // replies are never among them. An error counts until a person touches the
    // todo, as an attempt does: a retry takes it off the list.
    const rows = resultRows<AttentionRow>(
      await db.execute(sql`
        SELECT a.* FROM (
          SELECT
            t.id AS todo_id, t.title, p.id AS project_id, p.name AS project_name,
            l.id AS lane_id, l.name AS lane_name,
            last.id AS run_id, last.started_at AS last_started_at,
            coalesce(last.status = 'error' AND last.started_at > coalesce(
              (SELECT max(e.at) FROM todo_events e WHERE e.todo_id = t.id AND e.actor_kind = 'user'),
              '-infinity'::timestamptz
            ), false) AS errored,
            CASE WHEN last.status = 'error' OR last.verdict = 'fail' THEN coalesce(last.error, last.output) END AS reason,
            ${failuresSinceTouched(sql`t.id`)} AS attempts,
            CASE WHEN l.agent_id IS NOT NULL THEN l.max_attempts END AS max_attempts
          FROM todos t
          JOIN projects p ON p.id = t.project_id
          LEFT JOIN lanes l ON l.id = t.lane_id
          LEFT JOIN LATERAL (
            SELECT r.id, r.status, r.verdict, r.error, r.output, r.started_at FROM runs r
            WHERE r.todo_id = t.id AND r.status IN ('ok', 'error')
            ORDER BY r.started_at DESC LIMIT 1
          ) last ON true
          WHERE t.user_id = ${userId} AND p.ai_enabled AND p.archived_at IS NULL
            AND t.completed_at IS NULL AND t.archived_at IS NULL AND NOT t.ai_ignored
            AND NOT coalesce(l.is_done, false)
            AND NOT EXISTS (
              SELECT 1 FROM runs r
              WHERE r.todo_id = t.id AND r.status = 'running' AND r.lease_expires_at > now()
            )
        ) a
        WHERE a.errored OR (a.max_attempts IS NOT NULL AND a.attempts > a.max_attempts)
        ORDER BY a.last_started_at DESC NULLS LAST, a.title
      `),
    );
    return rows.map((row) => ({
      todoId: row.todo_id,
      title: row.title,
      projectId: row.project_id,
      projectName: row.project_name,
      laneId: row.lane_id,
      laneName: row.lane_name,
      outOfAttempts: row.max_attempts !== null && Number(row.attempts) > row.max_attempts,
      errored: row.errored,
      reason: row.reason?.trim() || null,
      runId: row.run_id,
      attempts: Number(row.attempts),
      maxAttempts: row.max_attempts,
    }));
  };

  return extendedSchema;
}
