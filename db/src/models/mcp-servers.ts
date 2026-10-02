import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { users } from './users.ts';

/** A tool a server offered the last time it was tested. */
export interface McpServerTool {
  name: string;
  description: string;
}

// An MCP server the account's agents may reach: an HTTP endpoint, or a command
// the runner spawns. One row per server, however many agents use it; an agent
// names the ones it may reach by slug (`agents.mcp_server_slugs`).
//
// `headers` and `env` are secrets, as an agent's API key is. They are excluded
// from the generated GraphQL surface (build-schema.ts), written through
// `setMcpServerSecret` and read only by the runner, through `claimRun`.
//
// The slug is what the server's tools are named under (`slug__tool`), so it is
// what an agent's list holds. Renaming one follows through to those lists
// (the `mcp_servers_rename` trigger, mcp_servers migration).
export const mcpServers = pgTable(
  'mcp_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    url: text('url'),
    // Spawned on the runner's host, and only when it sets RUNNER_ALLOW_STDIO.
    command: text('command'),
    args: jsonb('args').$type<string[]>().notNull().default([]),
    headers: jsonb('headers').$type<Record<string, string>>().notNull().default({}),
    env: jsonb('env').$type<Record<string, string>>().notNull().default({}),
    // `ToolHook`s, as @cubicecho/agent-mcp-pool reads them. The runner checks them.
    hooks: jsonb('hooks').$type<unknown[]>().notNull().default([]),
    // Tools the model is not offered, for the hooks' use.
    hiddenTools: jsonb('hidden_tools').$type<string[]>().notNull().default([]),
    // Off, no agent reaches it, whatever its list says.
    enabled: boolean('enabled').notNull().default(true),
    // What the last test found (`testMcpServer`). Written only by the server.
    checkedAt: timestamp('checked_at', { withTimezone: true }),
    checkOk: boolean('check_ok'),
    checkError: text('check_error'),
    tools: jsonb('tools').$type<McpServerTool[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index('idx_mcp_servers_user_id').on(t.userId),
    uniqueIndex('uq_mcp_servers_user_slug').on(t.userId, t.slug),
    // `telos` is the board's own door, which every run already has.
    check('ck_mcp_servers_slug', sql`${t.slug} ~ '^[A-Za-z0-9_-]+$' AND ${t.slug} <> 'telos'`),
    check('ck_mcp_servers_target', sql`${t.url} IS NOT NULL OR ${t.command} IS NOT NULL`),
  ],
);

export type McpServer = typeof mcpServers.$inferSelect;
export type NewMcpServer = typeof mcpServers.$inferInsert;
