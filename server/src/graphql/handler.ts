import type { Request } from 'express';
import type { GraphQLSchema } from 'graphql';
import { createYoga } from 'graphql-yoga';
import { isProduction } from '../core/config.ts';
import type { Context } from '../core/context.ts';
import type { ContextFactory } from './context-factory.ts';
import { graphqlLogger } from './logger.ts';

/** What Express hands Yoga alongside the fetch Request. */
interface ServerContext {
  /** The Express request. Absent when a test calls `yoga.fetch`. */
  req?: Request;
}

/**
 * Builds the Yoga handler for /graphql: queries and mutations over HTTP, and
 * subscriptions (a live board) over Server-Sent Events on the same path, in
 * GraphQL over SSE's distinct-connections mode. There is no socket: the session
 * rides in the same `Authorization` header as every other request.
 *
 * Errors a client should read are GraphQLErrors with a code; anything else is
 * masked as "Unexpected error." and logged with its cause (logger.ts).
 *
 * @param schema - The schema to serve.
 * @param contextFor - Builds a request's context, as /mcp does too.
 * @returns The Yoga instance, callable as Express middleware.
 */
export function createGraphQLHandler(schema: GraphQLSchema, contextFor: ContextFactory) {
  return createYoga<ServerContext, Context>({
    schema,
    graphqlEndpoint: '/graphql',
    graphiql: !isProduction(),
    logging: graphqlLogger,
    // Express's view of the caller, which honours TRUST_PROXY.
    context: ({ request, req }) => contextFor(request.headers, req?.ip),
  });
}
