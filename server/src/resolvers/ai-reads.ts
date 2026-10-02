import * as dbSchema from '@telos/db/schema';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { extendSchema, type GraphQLObjectType, type GraphQLSchema, parse } from 'graphql';
import { requireAi } from '../ai-gate.ts';
import { resultRows } from '../blocking.ts';
import type { Context } from '../context.ts';
import { DELETED_AGENT, SPEND_SUMS, type SpendRow, spendLine } from './account-activity.ts';

// Two things the AI side reads that the generated lists cannot give it.
//
// The roster: an agent's row holds its key, its endpoint, its prompt and its
// MCP servers with their headers and environment, so the table is closed to AI
// whole (tenancy.ts). This is what a caller needs of it and no more: who the
// agents are, to start a draft with one, and which lanes each works.
//
// Spend: `accountSpend` is a person's and covers every project they own. This
// is the same sum over the projects AI may see.
//
// Applied only when the instance has AI on.

// biome-ignore lint/suspicious/noExplicitAny: drizzle-orm 1.0 table/column type compat
type AnyRow = any;

const AI_READS_SDL = parse(`
  "A lane an agent works, on a board open to AI."
  type AgentStation {
    laneId: ID!
    laneName: String!
    projectId: ID!
    projectName: String!
    "work, verdict or expand."
    contract: String!
  }

  "An agent as the AI side may know it. Never its key, its endpoint, its prompt or its MCP servers."
  type AgentSummary {
    id: ID!
    name: String!
    model: String!
    "Whether a key is stored for it. The key itself is never read back."
    hasApiKey: Boolean!
    "The lanes it works, in projects with AI on."
    stations: [AgentStation!]!
  }

  "What the runs in projects open to AI spent since a moment."
  type AiSpend {
    since: DateTime!
    total: SpendLine!
    "Each such project with a run in the window, the most spent first."
    byProject: [SpendLine!]!
    "Each agent with a run in the window, the most spent first."
    byAgent: [SpendLine!]!
  }

  extend type Query {
    "Your agents and the lanes they work, without anything secret about them."
    agentRoster: [AgentSummary!]!
    "What runs spent since a moment, in the projects that have AI on, by project and by agent."
    aiSpend(since: DateTime!): AiSpend!
  }
`);

interface StationRow {
  agentId: string;
  laneId: string;
  laneName: string;
  projectId: string;
  projectName: string;
  contract: string;
}

/**
 * Adds `agentRoster` and `aiSpend` to the schema.
 *
 * @param schema - The schema so far.
 * @returns The schema with the AI side's reads.
 */
export function applyAiReadsExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, AI_READS_SDL);
  const queries = (extendedSchema.getType('Query') as GraphQLObjectType).getFields();

  queries.agentRoster.resolve = async (_parent: unknown, _args: unknown, context: Context) => {
    const userId = await requireAi(context);
    const db = context.db as AnyRow;
    // Named columns, never the row: the key and the servers stay where they are.
    const agents: Array<{ id: string; name: string; model: string; hasApiKey: boolean }> = await db
      .select({
        id: dbSchema.agents.id,
        name: dbSchema.agents.name,
        model: dbSchema.agents.model,
        hasApiKey: sql<boolean>`${dbSchema.agents.apiKey} is not null and ${dbSchema.agents.apiKey} <> ''`,
      })
      .from(dbSchema.agents)
      .where(eq(dbSchema.agents.userId, userId))
      .orderBy(asc(dbSchema.agents.name), asc(dbSchema.agents.createdAt));
    const stations: StationRow[] = await db
      .select({
        agentId: dbSchema.lanes.agentId,
        laneId: dbSchema.lanes.id,
        laneName: dbSchema.lanes.name,
        projectId: dbSchema.projects.id,
        projectName: dbSchema.projects.name,
        contract: dbSchema.lanes.contract,
      })
      .from(dbSchema.lanes)
      .innerJoin(dbSchema.projects, eq(dbSchema.projects.id, dbSchema.lanes.projectId))
      .where(
        and(
          eq(dbSchema.lanes.userId, userId),
          eq(dbSchema.projects.aiEnabled, true),
          isNull(dbSchema.projects.archivedAt),
          sql`${dbSchema.lanes.agentId} is not null`,
        ),
      )
      .orderBy(asc(dbSchema.projects.name), asc(dbSchema.lanes.position));
    return agents.map((agent) => ({
      ...agent,
      stations: stations.filter((station) => station.agentId === agent.id),
    }));
  };

  queries.aiSpend.resolve = async (_parent: unknown, args: { since: Date | string }, context: Context) => {
    const userId = await requireAi(context);
    const db = context.db as AnyRow;
    const since = new Date(args.since);
    const window = sql`r.user_id = ${userId} AND p.ai_enabled AND r.started_at >= ${since.toISOString()}::timestamptz`;
    const runs = sql`runs r JOIN projects p ON p.id = r.project_id`;

    const [total] = resultRows<SpendRow>(
      await db.execute(sql`SELECT NULL AS id, NULL AS name, ${SPEND_SUMS} FROM ${runs} WHERE ${window}`),
    );
    const byProject = resultRows<SpendRow>(
      await db.execute(sql`
        SELECT p.id, p.name, ${SPEND_SUMS}
        FROM ${runs}
        WHERE ${window}
        GROUP BY p.id, p.name
        ORDER BY total_tokens DESC, runs DESC, p.name
      `),
    );
    const byAgent = resultRows<SpendRow>(
      await db.execute(sql`
        SELECT a.id, a.name, ${SPEND_SUMS}
        FROM ${runs} LEFT JOIN agents a ON a.id = r.agent_id
        WHERE ${window}
        GROUP BY a.id, a.name
        ORDER BY total_tokens DESC, runs DESC, a.name
      `),
    );
    return {
      since,
      total: spendLine(total, 'Every project with AI on'),
      byProject: byProject.map((row) => spendLine(row, 'A project')),
      byAgent: byAgent.map((row) => spendLine(row, DELETED_AGENT)),
    };
  };

  return extendedSchema;
}
