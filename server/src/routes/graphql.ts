import type { Server } from 'node:http';
import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { expressMiddleware } from '@as-integrations/express5';
import express, { Router } from 'express';
import { toHeaders } from '../auth.ts';
import type { Context } from '../context.ts';
import type { ContextFactory } from '../request-context.ts';
import { schema } from '../schema.ts';

export type { Context };

export async function createGraphQLRouter(httpServer: Server, contextFor: ContextFactory) {
  const apolloServer = new ApolloServer<Context>({
    schema,
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  });

  await apolloServer.start();

  const router = Router();

  router.use(
    express.json({ limit: '1mb' }),
    expressMiddleware(apolloServer, {
      context: ({ req }) => contextFor(toHeaders(req.headers)),
    }),
  );

  return router;
}
