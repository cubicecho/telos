import { sql } from 'drizzle-orm';
import { boolean, check, doublePrecision, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { users } from './users.ts';

// What an account's agents inherit: the layer under every agent, as the agent
// spec has it (`resolveAgentSpec([defaults, agent])` in runner/src/spec.ts).
// One row per account, and a missing row reads as no defaults, so nothing
// needs seeding. Every column is nullable, because null is "this layer says
// nothing" and lets agent-core's own fallback through; `0` and `""` are values.
//
// `apiKey` is a secret, kept as an agent's is: written only with
// `setAgentDefaultsApiKey`, read only by the runner with a claim, and sent
// only to the endpoint it was entered for (agent-core's `resolveApiKey`). The
// table is the server's (SERVER_TABLES): `agentDefaults` and
// `setAgentDefaults` are the only ways in, and they are a person's.
export const agentDefaults = pgTable(
  'agent_defaults',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    baseUrl: text('base_url'),
    model: text('model'),
    apiKey: text('api_key'),
    temperature: doublePrecision('temperature'),
    maxTokens: integer('max_tokens'),
    contextLength: integer('context_length'),
    maxToolIterations: integer('max_tool_iterations'),
    toolDiscovery: boolean('tool_discovery'),
    toolSelectModel: text('tool_select_model'),
    reasoningEffort: text('reasoning_effort'),
    requestTimeoutSeconds: integer('request_timeout_seconds'),
    maxRetries: integer('max_retries'),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [check('ck_agent_defaults_max_tool_iterations', sql`${t.maxToolIterations} > 0`)],
);

export type AgentDefaults = typeof agentDefaults.$inferSelect;
