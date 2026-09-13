import path from 'node:path';
import { defineConfig } from 'vitest/config';

const alias = [
  { find: '@', replacement: path.resolve(__dirname, './app/src') },
  // graphql ships no exports map: Vite follows `module` to index.mjs while
  // Node follows `main` to index.js, so a schema built on one copy fails the
  // instanceof checks of the other. Pin the bare specifier to Node's copy.
  { find: /^graphql$/, replacement: path.resolve(__dirname, './node_modules/graphql/index.js') },
];

// Two projects, because two kinds of test want two different worlds and one
// global `environment` cannot be both. The server and db tests run a real
// Postgres in-process and must not pay for a DOM; the component tests are a
// DOM and nothing else. Splitting them is also what finally made component
// tests possible here — there was no jsdom at all before, and the app's ~30
// components had no coverage as a result.
export default defineConfig({
  resolve: { alias },
  test: {
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**'],
    // A test that forgets to build its own throwaway database gets an empty URL
    // and fails loudly, rather than quietly writing to the developer's Postgres.
    env: { DATABASE_URL: '' },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['db/**/*.test.ts', 'server/**/*.test.ts', 'app/src/lib/**/*.test.ts'],
        },
      },
      {
        extends: true,
        resolve: {
          alias: [
            ...alias,
            // `lib/apollo.ts` imports `Platform` from react-native, which the
            // web build already resolves this way — Expo's metro config does it
            // for the bundle, and nothing here reads the metro config.
            { find: /^react-native$/, replacement: 'react-native-web' },
          ],
        },
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['./vitest.setup.ts'],
          include: ['app/**/*.test.tsx'],
        },
      },
    ],
  },
});
