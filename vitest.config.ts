import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // A test that forgets to build its own throwaway database gets an empty URL
    // and fails loudly, rather than quietly writing to the developer's Postgres.
    env: { DATABASE_URL: '' },
  },
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './app/src') },
      // graphql ships no exports map: Vite follows `module` to index.mjs while
      // Node follows `main` to index.js, so a schema built on one copy fails the
      // instanceof checks of the other. Pin the bare specifier to Node's copy.
      { find: /^graphql$/, replacement: path.resolve(__dirname, './node_modules/graphql/index.js') },
    ],
  },
});
