import type { ServerResponse } from 'node:http';
import { connectServer, createServerFactory, type McpHttpHandler, type McpHttpRequest } from '@cubicecho/graphql-mcp';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ErrorCode,
  isJSONRPCRequest,
  isJSONRPCResultResponse,
  type JSONRPCMessage,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import express, { type Express, type Response } from 'express';
import { type GraphQLSchema, Source } from 'graphql';
import { toHeaders } from './auth.ts';
import { DOOR_OPERATIONS, toolsOff } from './door.ts';
import { instanceAiOn } from './instance.ts';
import { createLoaders } from './loaders.ts';
import { registerPrompts } from './mcp-prompts.ts';
import type { ContextFactory } from './request-context.ts';

// The AI door: the same schema as /graphql, served as MCP tools to a client
// holding an API key. The tools are the hand-written operations in
// mcp.graphql and nothing else, so what an MCP client can do is what that file
// says — the generated CRUD surface is never projected. Behind it, the same
// tenancy narrows what a key sees (tenancy.ts) and the actor lock refuses any
// write but the ones meant for AI (resolvers/actor-lock.ts); the tool list is
// the menu, not the lock.
//
// A key has a switch per tool (door.ts). A tool that is off for the key is
// taken out of the listing it is sent and answered as a tool that is not
// there, here; the lock refuses what the tool would have done as well, so a
// key that reaches /graphql instead gets no further.
//
// Mounted only when the instance has AI on. Off, /mcp is a plain 404.

export const MCP_NAME = 'telos';

const TOOLS_LIST = 'tools/list';
const TOOLS_CALL = 'tools/call';

/**
 * A tool listing without the tools that are off.
 *
 * @param message A message on its way to the client.
 * @param off The names of the tools that are off.
 * @returns The message, its `tools` narrowed when it has any.
 */
function withoutTools(message: JSONRPCMessage, off: ReadonlySet<string>): JSONRPCMessage {
  if (!isJSONRPCResultResponse(message) || !Array.isArray(message.result.tools)) {
    return message;
  }
  const tools = message.result.tools.filter((tool: unknown) => {
    const named = typeof tool === 'object' && tool !== null && 'name' in tool ? tool.name : undefined;
    return typeof named !== 'string' || !off.has(named);
  });
  return { ...message, result: { ...message.result, tools } };
}

/**
 * Closes the tools a key has switched off, on one request's transport: they
 * leave the listing, and a call to one is answered as the SDK answers a tool
 * it has never heard of. Done on the transport because the listing is built
 * once and shared by every server the factory mints.
 *
 * @param transport The request's transport, already connected.
 * @param off The names of the tools that are off.
 * @returns Nothing.
 */
function closeTools(transport: StreamableHTTPServerTransport, off: ReadonlySet<string>): void {
  const listings = new Set<RequestId>();
  const deliver = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (isJSONRPCRequest(message)) {
      if (message.method === TOOLS_LIST) {
        listings.add(message.id);
      }
      const name = message.method === TOOLS_CALL ? message.params?.name : undefined;
      if (typeof name === 'string' && off.has(name)) {
        const text = `MCP error ${ErrorCode.InvalidParams}: Tool ${name} not found`;
        transport
          .send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }], isError: true } })
          .catch((error: unknown) => console.error('[mcp] refusal failed:', error));
        return;
      }
    }
    deliver?.(message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const listing = isJSONRPCResultResponse(message) && listings.has(message.id);
    return send(listing ? withoutTools(message, off) : message, options);
  };
}

/**
 * Builds the door: a handler that answers each request with a server of its
 * own, as the caller the request's headers say it is.
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
    operations: [new Source(DOOR_OPERATIONS, 'mcp.graphql')],
    // Only the operations above: no tool per root field.
    include: [],
    mutationHints: 'byName',
    // Orientation and jobs of work, beside the tools (mcp-prompts.ts).
    decorateServer: registerPrompts,
  });
  const handler = async (req: McpHttpRequest, res: ServerResponse): Promise<void> => {
    // Who is calling is settled once, since it decides which tools there are.
    // Each call still gets loaders of its own.
    const context = await contextFor(toHeaders(req.headers));
    const server = makeServer(() => ({ ...context, loaders: createLoaders(context.db) }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await connectServer(server, transport);
    const off = toolsOff(context.actor);
    if (off.size > 0) {
      closeTools(transport, off);
    }
    await transport.handleRequest(req, res, req.body);
  };
  // Nothing outlives a request, so there is nothing to close.
  return Object.assign(handler, { close: async (): Promise<void> => {} });
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
