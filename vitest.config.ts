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
    // Worker threads rather than Vitest's default child processes: a thread
    // starts faster and shares the process's memory, and nothing here needs
    // process isolation — PGlite runs in-thread, and each test builds its own.
    //
    // And unisolated: a worker loads the server once and runs every file it is
    // given against that, rather than re-importing it per file — importing was
    // most of the node project's time. It holds because no node test uses
    // `vi.mock`, and one that changes the environment or a global puts it back.
    // Vitest 3 reads this from the root only, which is why the dom project,
    // which does mock modules, runs on forks: that pool keeps isolating.
    pool: 'threads',
    poolOptions: { threads: { isolate: false } },
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
          // Each test builds its own database, and a test that claims a run
          // and drives it over /mcp takes 6–8s on CI's runners: the default 5s
          // failed main's own checks as well as this branch's.
          testTimeout: 20_000,
          include: [
            'db/**/*.test.ts',
            'server/**/*.test.ts',
            'runner/**/*.test.ts',
            'better-auth-graphql/**/*.test.ts',
            'scripts/**/*.test.ts',
            'app/src/lib/**/*.test.ts',
          ],
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
          // cubeui's split components ship `x.tsx` for device and `x.web.tsx`
          // for the browser, and Metro picks the web half by extension. Vite
          // has to be told the same preference, or the tests render the native
          // half against react-native-web.
          extensions: ['.web.tsx', '.web.ts', '.tsx', '.ts', '.web.js', '.js', '.mjs', '.json'],
        },
        test: {
          name: 'dom',
          // Isolated per file, because these tests `vi.mock` modules. Measured
          // the same speed as threads.
          pool: 'forks',
          environment: 'jsdom',
          // Pre-bundled, so a test file loads each of these as one module
          // instead of the hundreds behind its barrel. `date-fns` alone, which
          // cubeui's date input imports whole, took 2.6s per file unbundled.
          deps: {
            optimizer: {
              web: {
                enabled: true,
                include: [
                  'date-fns',
                  'radix-ui',
                  'lucide-react',
                  'react-day-picker',
                  '@tanstack/react-form',
                  '@dnd-kit/core',
                  '@dnd-kit/sortable',
                  '@apollo/client',
                  'tailwind-merge',
                ],
              },
            },
          },
          setupFiles: ['./vitest.setup.ts'],
          include: ['app/**/*.test.tsx'],
        },
      },
    ],
  },
});
