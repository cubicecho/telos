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

// Somebody the board can hand work to: a model behind an OpenAI-compatible
// endpoint, with whatever tools it is given. An agent is nothing until a lane
// names it (lanes.agentId); what it is asked to do is the lane's business.
// It says only what is different about it: what it leaves null comes from the
// account's defaults, layered by the runner (runner/src/spec.ts).
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
    // Off, no station claims a run for it and no draft is answered by it.
    enabled: boolean('enabled').notNull().default(true),
    // An OpenAI-compatible base URL: Ollama, llama.cpp, vLLM, a hosted API.
    // Null here and below inherits from the account's defaults
    // (agent-defaults.ts); `0` and `""` are values, as the agent spec says.
    baseUrl: text('base_url'),
    model: text('model'),
    apiKey: text('api_key'),
    // Who the agent is, whichever lane it works in. The lane adds the job.
    systemPrompt: text('system_prompt'),
    temperature: doublePrecision('temperature'),
    maxTokens: integer('max_tokens'),
    contextLength: integer('context_length'),
    maxToolIterations: integer('max_tool_iterations'),
    // Offer the model only the tools a cheap first pass picks, for servers with
    // more tools than a small context holds.
    toolDiscovery: boolean('tool_discovery'),
    toolSelectModel: text('tool_select_model'),
    /** agent-core's `reasoning_effort`: a level, or "off" for none. Null inherits. */
    reasoningEffort: text('reasoning_effort'),
    requestTimeoutSeconds: integer('request_timeout_seconds'),
    maxRetries: integer('max_retries'),
    // The account's MCP servers it may reach, by slug (mcp-servers.ts). Null is
    // every server, an empty list is none, a list is exactly those: the three
    // states of the agent spec's `tools.servers`.
    mcpServerSlugs: jsonb('mcp_server_slugs').$type<string[]>(),
    // The MCP door's tools its runs have off, by name, as a key's switches are
    // (api_key_tools). Null is the default for a run (door.ts
    // `RUN_DEFAULT_OFF`): it reads, adds work and leaves notes, and the rest is
    // off until a person turns it on. Kept null rather than written out, so a
    // writing tool added to the door later is off for these agents too.
    toolsOff: jsonb('tools_off').$type<string[]>(),
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
