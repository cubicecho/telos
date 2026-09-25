import { readFileSync } from 'node:fs';
import { createHttpHandler, type McpHttpHandler } from '@cubicecho/graphql-mcp';
import express, { type Express, type Response } from 'express';
import { type GraphQLSchema, Source } from 'graphql';
import { toHeaders } from './auth.ts';
import { instanceAiOn } from './instance.ts';
import type { ContextFactory } from './request-context.ts';

// The AI door: the same schema as /graphql, served as MCP tools to a client
// holding an API key. The tools are the hand-written operations in
// mcp.graphql and nothing else, so what an MCP client can do is what that file
// says — the generated CRUD surface is never projected. Behind it, the same
// tenancy narrows what a key sees (tenancy.ts) and the actor lock refuses any
// write but the few meant for AI (resolvers/actor-lock.ts); the tool list is
// the menu, not the lock.
//
// Mounted only when the instance has AI on. Off, /mcp is a plain 404.

const OPERATIONS_PATH = new URL('./mcp.graphql', import.meta.url);

export const MCP_NAME = 'telos';

export function createMcpHandler(schema: GraphQLSchema, contextFor: ContextFactory, version: string): McpHttpHandler {
  return createHttpHandler({
    schema,
    name: MCP_NAME,
    version,
    operations: [new Source(readFileSync(OPERATIONS_PATH, 'utf8'), 'mcp.graphql')],
    // Only the operations above: no tool per root field.
    include: [],
    mutationHints: 'byName',
    contextFromRequest: (req) => contextFor(toHeaders(req.headers)),
  });
}

/**
 * Mounts /mcp. With AI off, on the server or by the instance's switch, it
 * answers 404 itself rather than falling through to the app's static fallback,
 * which would hand an MCP client a web page.
 * Returns the handler, for closing on shutdown, or null when there is none.
 */
export function mountMcp(
  app: Express,
  // biome-ignore lint/suspicious/noExplicitAny: db type varies by driver
  options: { ai: boolean; db: any; schema: GraphQLSchema; contextFor: ContextFactory; version: string },
): McpHttpHandler | null {
  const off = (res: Response): void => {
    res.status(404).json({ error: 'AI is switched off on this server.' });
  };
  if (!options.ai) {
    app.all('/mcp', (_req, res) => off(res));
    return null;
  }
  const handler = createMcpHandler(options.schema, options.contextFor, options.version);
  app.all('/mcp', express.json({ limit: '1mb' }), (req, res, next) => {
    instanceAiOn(options.db)
      .then((on) => (on ? handler(req, res) : off(res)))
      .catch((error: unknown) => {
        console.error('[mcp] request failed:', error);
        next(error);
      });
  });
  return handler;
}
