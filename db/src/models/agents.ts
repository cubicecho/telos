import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { users } from './users.ts';

/**
 * An MCP server an agent may use: an HTTP endpoint, or a command to spawn.
 * The shape `@cubicecho/agent-mcp-pool` reads.
 */
export interface AgentMcpServer {
  id: string;
  name?: string | undefined;
  url?: string | undefined;
  command?: string | undefined;
  args?: string[] | undefined;
  headers?: Record<string, string> | undefined;
  env?: Record<string, string> | undefined;
}

// Somebody the board can hand work to: a model behind an OpenAI-compatible
// endpoint, with whatever tools it is given. An agent is nothing until a lane
// names it (lanes.agentId); what it is asked to do is the lane's business.
//
// `apiKey` is the one secret in the schema. It is excluded from the generated
// GraphQL surface (build-schema.ts), written through `setAgentApiKey` and read
// only by the runner, through `claimRun`.
export const agents = pgTable(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // An OpenAI-compatible base URL: Ollama, llama.cpp, vLLM, a hosted API.
    baseUrl: text('base_url').notNull(),
    model: text('model').notNull(),
    apiKey: text('api_key'),
    // Who the agent is, whichever lane it works in. The lane adds the job.
    systemPrompt: text('system_prompt'),
    temperature: doublePrecision('temperature'),
    maxTokens: integer('max_tokens'),
    contextLength: integer('context_length'),
    maxToolIterations: integer('max_tool_iterations').notNull().default(20),
    // Offer the model only the tools a cheap first pass picks, for servers with
    // more tools than a small context holds.
    toolDiscovery: boolean('tool_discovery').notNull().default(false),
    toolSelectModel: text('tool_select_model'),
    requestTimeoutSeconds: integer('request_timeout_seconds'),
    maxRetries: integer('max_retries'),
    mcpServers: jsonb('mcp_servers').$type<AgentMcpServer[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_agents_user_id').on(t.userId),
    check('ck_agents_max_tool_iterations', sql`${t.maxToolIterations} > 0`),
  ],
);

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;
