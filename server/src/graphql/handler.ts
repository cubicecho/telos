import type { Request, Response } from 'express';
import type { GraphQLSchema } from 'graphql';
import { createYoga } from 'graphql-yoga';
import type { AuthHost } from '../auth/auth-host.ts';
import { isProduction } from '../core/config.ts';
import type { Context } from '../core/context.ts';
import { bearerChallenge } from '../http/protected-resource.ts';
import type { ContextFactory } from './context-factory.ts';
import { graphqlLogger } from './logger.ts';

/** What Express hands Yoga alongside the fetch Request. */
interface ServerContext {
  /** The Express request. Absent when a test calls `yoga.fetch`. */
  req?: Request;
  /** The Express response, for a header Yoga's own do not cover. Absent with `yoga.fetch`. */
  res?: Response;
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
 * A refused bearer, while there is an OIDC provider, gets a `WWW-Authenticate`
 * challenge naming this server's protected-resource metadata
 * (http/protected-resource.ts), so a device app knows where to get a token.
 *
 * @param schema - The schema to serve.
 * @param contextFor - Builds a request's context, as /mcp does too.
 * @param authHost - Where the provider in effect is, for the challenge.
 * @returns The Yoga instance, callable as Express middleware.
 */
export function createGraphQLHandler(schema: GraphQLSchema, contextFor: ContextFactory, authHost: AuthHost) {
  return createYoga<ServerContext, Context>({
    schema,
    graphqlEndpoint: '/graphql',
    graphiql: !isProduction(),
    logging: graphqlLogger,
    // Express's view of the caller, which honours TRUST_PROXY.
    context: async ({ request, req, res }) => {
      const context = await contextFor(request.headers, req?.ip);
      const challenge = bearerChallenge(authHost, request.headers, context.actor);
      // Node merges this with the headers Yoga writes.
      if (challenge && res && !res.headersSent) res.setHeader('WWW-Authenticate', challenge);
      return context;
    },
  });
}
