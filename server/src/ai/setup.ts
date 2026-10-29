import type { DB } from '@telos/db';
import { sql } from 'drizzle-orm';
import { extendSchema, type GraphQLSchema, parse } from 'graphql';
import type { QueryResolvers } from '../../__generated__/resolvers.ts';
import { attachResolvers } from '../graphql/attach-resolvers.ts';
import { runnerSeenAt } from '../runs/runner-seen.ts';
import { resultRows } from '../todos/blocking.ts';
import { requireAi } from './gate.ts';

// What still stands between an account and its first run, once AI is on for
// it: the steps a person takes in several places, read back in one. Nothing is
// remembered; every answer is what the tables say now.
//
// Applied only when the instance has AI on.

const AI_SETUP_SDL = parse(`
  "What is in place for an agent to work a todo of yours. Read now, never remembered."
  type AiSetup {
    "You have an agent."
    agent: Boolean!
    "A project of yours has a lane with an agent."
    station: Boolean!
    "Your projects that have a lane with an agent, the one furthest along first: AI on, then running by itself, then oldest."
    stationProjectIds: [ID!]!
    "AI is on for a project that has a lane with an agent."
    projectAi: Boolean!
    "There is something to work: an open todo in a lane with an agent in such a project, or a run already made."
    request: Boolean!
    "Work may start: such a project runs by itself, or a todo was asked for with runTodo, or a run was already made."
    started: Boolean!
    "When the runner last asked for work. Null when it has not since the server started."
    runnerSeenAt: DateTime
  }

  extend type Query {
    "What is in place for a first run, and what is not."
    aiSetup: AiSetup!
  }
`);

/** What the one statement behind `aiSetup` answers. */
interface SetupRow {
  agent: boolean;
  agent_project_ids: string[];
  project_ai: boolean;
  request: boolean;
  started: boolean;
}

/**
 * Reads what an account has in place for a first run.
 *
 * @param db - The database or transaction.
 * @param userId - The account.
 * @returns The answers, apart from the runner's.
 */
async function readSetup(db: DB, userId: string): Promise<SetupRow> {
  const result = await db.execute(sql`
    WITH agent_projects AS (
      SELECT p.id, p.ai_enabled, p.run_mode = 'auto' AS auto_run, p.created_at
      FROM projects p
      WHERE p.user_id = ${userId} AND p.archived_at IS NULL
        AND EXISTS (SELECT 1 FROM lanes l WHERE l.project_id = p.id AND l.agent_id IS NOT NULL)
    ),
    has_run AS (
      SELECT EXISTS (SELECT 1 FROM runs r WHERE r.user_id = ${userId}) AS yes
    )
    SELECT
      EXISTS (SELECT 1 FROM agents a WHERE a.user_id = ${userId} AND a.enabled) AS agent,
      COALESCE(
        (SELECT json_agg(s.id ORDER BY s.ai_enabled DESC, s.auto_run DESC, s.created_at) FROM agent_projects s),
        '[]'::json
      ) AS agent_project_ids,
      EXISTS (SELECT 1 FROM agent_projects s WHERE s.ai_enabled) AS project_ai,
      (
        (SELECT yes FROM has_run)
        OR EXISTS (
          SELECT 1 FROM todos t
          JOIN agent_projects s ON s.id = t.project_id AND s.ai_enabled
          JOIN lanes l ON l.id = t.lane_id AND l.agent_id IS NOT NULL
          WHERE t.completed_at IS NULL AND t.archived_at IS NULL AND NOT t.ai_ignored
        )
      ) AS request,
      (
        (SELECT yes FROM has_run)
        OR EXISTS (SELECT 1 FROM agent_projects s WHERE s.ai_enabled AND s.auto_run)
        OR EXISTS (
          SELECT 1 FROM todos t
          JOIN agent_projects s ON s.id = t.project_id AND s.ai_enabled
          WHERE t.run_requested_at IS NOT NULL
        )
      ) AS started
  `);
  const [row] = resultRows<SetupRow>(result);
  return row;
}

/**
 * Adds `aiSetup` to the schema.
 *
 * @param schema - The schema so far.
 * @returns The schema with the setup query.
 */
export function applyAiSetupExtension(schema: GraphQLSchema): GraphQLSchema {
  const extendedSchema = extendSchema(schema, AI_SETUP_SDL);
  const queries: QueryResolvers = {};

  queries.aiSetup = async (_parent, _args, context) => {
    const userId = await requireAi(context);
    const row = await readSetup(context.db, userId);
    return {
      agent: row.agent,
      station: row.agent_project_ids.length > 0,
      stationProjectIds: row.agent_project_ids,
      projectAi: row.project_ai,
      request: row.request,
      started: row.started,
      runnerSeenAt: runnerSeenAt(),
    };
  };

  return attachResolvers(extendedSchema, { Query: queries });
}
