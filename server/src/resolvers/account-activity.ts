import * as dbSchema from '@telos/db/schema';
import { eq, sql } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { QueryResolvers } from '../../__generated__/resolvers.ts';
import { requireAi } from '../ai-gate.ts';
import { attachResolvers } from '../attach-resolvers.ts';
import { resultRows } from '../blocking.ts';
import { type HandBack, HandBackEnum, withEnums } from '../enums.ts';
import { type WorkTodo, workStates } from '../ready.ts';
import { requireSession } from './auth.ts';

// What an account's agents did and spent, across every project it owns: the
// two things the generated lists cannot say. Spend is the runs of a window
// added up by project and by agent, with where the window really starts when
// retention has trimmed it. Handed back is the todos a lane's agent gave up on
// or finished with and has nowhere to send: aiStatus's handedBack state, across
// every AI project.
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

  "A todo its lane's agent handed back: it gave up on it, or finished with it and has nowhere to send it."
  type HandedBackTodo {
    todoId: ID!
    title: String!
    projectId: ID!
    projectName: String!
    laneId: ID!
    laneName: String!
    "GAVE_UP (it failed more times than the lane allows) or FINISHED (with nowhere to send it)."
    handedBack: HandBack!
    "The error or the reviewer's reason of its last failed run, or where it finished."
    reason: String
    "Its last finished run."
    runId: ID
    "Failed runs since a person last touched it, as aiStatus counts them."
    attempts: Int!
    "How many its lane allows."
    maxAttempts: Int!
  }

  extend type Query {
    "What your runs spent since a moment, across every project, by project and by agent."
    accountSpend(since: DateTime!): AccountSpend!
    "Your todos, across your AI projects, that their lanes' agents handed back: the latest run first."
    accountHandedBack: [HandedBackTodo!]!
  }
`);

export interface SpendRow {
  id: string | null;
  name: string | null;
  runs: number;
  draft_replies: number;
  prompt_tokens: string | number;
  completion_tokens: string | number;
  total_tokens: string | number;
}

/** The columns every spend row has, over runs named `r`. */
export const SPEND_SUMS = sql`
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
export function spendLine(row: SpendRow | undefined, name: string) {
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
 * Adds `accountSpend` and `accountHandedBack` to the schema.
 *
 * @param schema - The schema so far.
 * @returns The schema with the account's activity queries.
 */
/** A handed-back todo's work: its lane has an agent, so a name and a limit. */
type HandedBackWork = WorkTodo & { handedBack: HandBack; laneId: string; laneName: string; maxAttempts: number };

function isHandedBack(todo: WorkTodo): todo is HandedBackWork {
  return (
    todo.state === 'handedBack' &&
    todo.handedBack !== null &&
    todo.laneId !== null &&
    todo.laneName !== null &&
    todo.maxAttempts !== null
  );
}

export function applyAccountActivityExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(withEnums(schema, [HandBackEnum]), ACCOUNT_ACTIVITY_SDL);
  const queries: QueryResolvers = {};

  queries.accountSpend = async (_parent, args, context) => {
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
    // Pruning keeps the few old runs readiness still counts, so this is where
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

  queries.accountHandedBack = async (_parent, _args, context) => {
    requireSession(context);
    const userId = await requireAi(context);
    const { todos } = await workStates(context.db, userId);
    return todos
      .filter(isHandedBack)
      .sort((a, b) => (b.lastRunAt?.getTime() ?? 0) - (a.lastRunAt?.getTime() ?? 0))
      .map((todo) => ({
        todoId: todo.todoId,
        title: todo.title,
        projectId: todo.projectId,
        projectName: todo.projectName,
        laneId: todo.laneId,
        laneName: todo.laneName,
        handedBack: todo.handedBack,
        reason: todo.reason,
        runId: todo.lastRunId,
        attempts: todo.failures,
        maxAttempts: todo.maxAttempts,
      }));
  };

  return attachResolvers(extendedSchema, { Query: queries });
}
