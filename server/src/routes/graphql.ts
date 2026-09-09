import type { Server } from 'node:http';
import { ApolloServer } from '@apollo/server';
import { ApolloServerPluginDrainHttpServer } from '@apollo/server/plugin/drainHttpServer';
import { expressMiddleware } from '@as-integrations/express5';
import { db } from '@telos/db';
import express, { Router } from 'express';
import type { Context } from '../context.ts';
import { createLoaders } from '../loaders.ts';
import { extractUserId } from '../resolvers/auth.ts';
import { schema } from '../schema.ts';

export type { Context };

export async function createGraphQLRouter(httpServer: Server) {
  const apolloServer = new ApolloServer<Context>({
    schema,
    plugins: [ApolloServerPluginDrainHttpServer({ httpServer })],
  });

  await apolloServer.start();

  const router = Router();

  router.use(
    express.json(),
    expressMiddleware(apolloServer, {
      // Loaders are built per request: their batching is only ever valid within
      // one request, and their cache must not outlive it.
      context: async ({ req }) => ({ db, userId: extractUserId(req), loaders: createLoaders(db) }),
    }),
  );

  return router;
}
