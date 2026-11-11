import { createHttpHandler, createServerFactory, type McpHttpHandler } from '@cubicecho/graphql-mcp';
import express, { type Express, type Response } from 'express';
import { type GraphQLSchema, Source } from 'graphql';
import type { Context } from '../core/context.ts';
import { HTTP_DEFAULTS } from '../core/defaults.ts';
import type { ContextFactory } from '../graphql/context-factory.ts';
import { createLoaders } from '../graphql/loaders.ts';
import { toHeaders } from '../http/headers.ts';
import { instanceAiOn } from '../instance/settings.ts';
import { DOOR_OPERATIONS, toolsOff } from './door.ts';
import { registerPrompts } from './prompts.ts';

// The AI door: the same schema as /graphql, served as MCP tools to a client
// holding an API key. The tools are the hand-written operations in
// mcp/door.graphql and nothing else, so what an MCP client can do is what that file
// says — the generated CRUD surface is never projected. Behind it, the same
// tenancy narrows what a key sees (tenancy.ts) and the permissions map refuses
// any write but the ones meant for AI (graphql/permissions.ts); the tool list is
// the menu, not the lock.
//
// A key has a switch per tool (door.ts), and so does a run, through its agent.
// A tool that is off for the caller is never registered on the server its
// request gets, so it is not listed and is answered as a tool that is not
// there; the lock refuses what the tool would have done as well, so a caller
// that reaches /graphql instead gets no further.
//
// Mounted only when the instance has AI on. Off, /mcp is a plain 404.

export const MCP_NAME = 'telos';

/**
 * Builds the door: a handler that answers each request with a server of its
 * own, as the caller the request's headers say it is, offering the tools that
 * caller has on. A tool that is off is left off the listing and answered as a
 * tool that does not exist.
 *
 * @param schema The schema the tools run against.
 * @param contextFor Builds a request's context from its headers.
 * @param version The server's version, as the client is told.
 * @returns The handler to mount on /mcp.
 */
export function createMcpHandler(schema: GraphQLSchema, contextFor: ContextFactory, version: string): McpHttpHandler {
  const makeServer = createServerFactory({
    schema,
    name: MCP_NAME,
    version,
    operations: [new Source(DOOR_OPERATIONS, 'door.graphql')],
    // Only the operations above: no tool per root field.
    include: [],
    mutationHints: 'byName',
    // Orientation and jobs of work, beside the tools (mcp/prompts.ts).
    decorateServer: registerPrompts,
  });
  return createHttpHandler({
    schema,
    // Who is calling is settled once, since it decides which tools there are.
    contextFromRequest: (req) =>
      contextFor(toHeaders(req.headers), 'ip' in req && typeof req.ip === 'string' ? req.ip : undefined),
    // Our own server rather than `toolsFor`, so each call still gets loaders of
    // its own rather than sharing the request's.
    serverFor: (_req, resolved) => {
      const context = resolved as Context;
      const off = toolsOff(context.actor);
      return makeServer(
        () => ({ ...context, loaders: createLoaders(context.db) }),
        off.size > 0 ? { exclude: off } : undefined,
      );
    },
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
  app.all('/mcp', express.json({ limit: HTTP_DEFAULTS.bodyLimit }), (req, res, next) => {
    instanceAiOn(options.db)
      .then((on) => (on ? handler(req, res) : off(res)))
      .catch((error: unknown) => {
        console.error('[mcp] request failed:', error);
        next(error);
      });
  });
  return handler;
}
