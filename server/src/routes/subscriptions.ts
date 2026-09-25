import type { Server } from 'node:http';
import type { GraphQLSchema } from 'graphql';
import { useServer as serveGraphQLWs } from 'graphql-ws/use/ws';
import { WebSocketServer } from 'ws';
import { toHeaders } from '../auth.ts';
import type { ContextFactory } from '../request-context.ts';

/**
 * The headers a socket's operations run with. A browser cannot set headers on
 * a WebSocket, so the client sends its bearer token in the connection's
 * params instead; it becomes the same `authorization` header an HTTP request
 * would carry, and the actor is resolved exactly as it is there.
 */
export function socketHeaders(connectionParams: Readonly<Record<string, unknown>> | undefined): Headers {
  const authorization = connectionParams?.authorization;
  return toHeaders(typeof authorization === 'string' ? { authorization } : {});
}

/**
 * Serves subscriptions (a live board) over a socket on /graphql; queries and
 * mutations stay on HTTP.
 *
 * @returns Closes the open sockets.
 */
export function serveSubscriptions(httpServer: Server, schema: GraphQLSchema, contextFor: ContextFactory) {
  const wsServer = new WebSocketServer({ server: httpServer, path: '/graphql' });
  const sockets = serveGraphQLWs<Record<string, unknown>>(
    { schema, context: (ctx) => contextFor(socketHeaders(ctx.connectionParams)) },
    wsServer,
  );
  return async () => {
    await sockets.dispose();
  };
}
