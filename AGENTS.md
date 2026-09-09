# AGENTS.md — Telos

## Project Overview

Telos is a self-hostable todo app. It is *just* todos: projects hold todos, todos
can depend on other todos, and labels attach to either. One monorepo (npm
workspaces) with three packages — `app/` (frontend), `server/` (GraphQL API),
`db/` (schema and connection) — and one container serves all of it.

## Tech Stack

| Layer    | Technology                                               |
| -------- | -------------------------------------------------------- |
| Frontend | React 19, Expo Router (web target), Apollo Client        |
| UI       | Tailwind CSS via NativeWind, shadcn/ui, Radix UI         |
| API      | Apollo Server 5 on Express 5, GraphQL                    |
| Database | Drizzle ORM + PostgreSQL (`postgres-js`)                 |
| Testing  | Vitest, PGlite as an in-memory Postgres fixture          |
| Linting  | Biome (formatter + linter)                               |
| Runtime  | Node.js 24+, ESM (`"type": "module"` throughout)         |

## Project Structure

```
telos/
├── app/                     # Frontend (Expo Router, web target)
│   ├── app/                 # File-based routes — the router reads THIS directory
│   │   ├── _layout.tsx      # Root layout (ApolloProvider + Stack)
│   │   ├── login.tsx        # Unauthenticated routes live at the top level
│   │   ├── auth/verify.tsx  # Magic-link landing page
│   │   └── (app)/           # Authenticated group (redirects to /login)
│   │       ├── index.tsx    # Redirects to the first project
│   │       ├── projects/[id].tsx
│   │       └── labels/index.tsx
│   ├── src/
│   │   ├── __generated__/   # Generated GraphQL types (do not edit, not committed)
│   │   ├── components/
│   │   │   ├── ui/          # shadcn/ui primitives — no app logic
│   │   │   ├── domain/      # project/, todo/, label/
│   │   │   └── layouts/     # sidebar
│   │   └── lib/             # apollo, auth, graphql documents, cn()
│   ├── app.json             # Expo config
│   ├── metro.config.js
│   └── tailwind.config.js
├── server/                  # GraphQL API (port 3002)
│   ├── __generated__/       # Generated SDL + resolver types (not committed)
│   └── src/
│       ├── index.ts         # Entry point: migrate, mount /graphql, serve the SPA
│       ├── preflight.ts     # Boot guards — imported first, on purpose
│       ├── build-schema.ts  # createSchema(db) — buildSchema + extensions
│       ├── schema.ts        # Binds createSchema to the real database
│       ├── tenancy.ts       # Row scope + server-owned columns, as buildSchema config
│       ├── blocking.ts      # The dependency rules, in one place
│       ├── loaders.ts       # Per-request DataLoaders
│       ├── resolvers/       # SDL extensions for what CRUD cannot express
│       └── __tests__/       # Server tests
├── db/
│   ├── drizzle/             # Generated migrations (committed)
│   └── src/
│       ├── models/          # One file per table — the actual definitions
│       ├── schema.ts        # Barrel re-exporting models/
│       ├── relations.ts     # defineRelations config (drives the GraphQL schema)
│       └── index.ts         # DB singleton + re-exports
├── .agents/mvp-plan.md      # The plan this repo was built from
├── vitest.config.ts
├── biome.json
└── package.json
```

## Commands

```bash
npm run dev              # server (3002) + Expo dev server (3004)
npm run db:up            # Postgres on ${POSTGRES_BIND:-127.0.0.1}:5435
npm run db:generate      # new migration from a schema change
npm run db:migrate       # apply migrations
npm run codegen          # GraphQL types for both server and app
npm run check            # codegen + biome + tsc --noEmit, all three workspaces
npm test                 # Vitest
```

`npm run check` is the gate. Run it before saying a change is done.

## How the API is built

**The GraphQL schema is generated from the Drizzle schema.** There are no
hand-written CRUD resolvers: `buildSchema(db, config)` from
`@vantreeseba/drizzle-graphql` produces queries, mutations, filters, aggregates
and relation fields for every table in `db/src/relations.ts`. Adding a column is
all it takes to expose it.

Two consequences worth internalising:

- **`relations.ts`, not `schema.ts`, is what the library reads.** A table with no
  entry there gets no relation fields.
- **Only what CRUD cannot express gets a resolver.** Those live in
  `server/src/resolvers/` and are applied by `build-schema.ts` in order.

## Rules that carry weight

**Every table needs a `scope` entry.** `server/src/tenancy.ts` maps each table to
a `RowScope` that is ANDed into the SQL of every generated read, update and
delete. A table missing from `scope` is visible across tenants, and nothing else
in the code will say so. `tenancy.test.ts` fails when you forget — do not delete
the test to make it pass.

**`scope` cannot reach a plain insert.** Any foreign key a caller can state gets
checked in an `onWrite` hook in `server/src/resolvers/write-guards.ts`. A new
table with a user-facing FK needs an entry in `FOREIGN_KEYS`.

**A blocked todo cannot be completed.** The rule is an invariant, not a code
path: `assertNoBlockedCompletions` re-checks it after any write that sets
`completedAt`, so `completeTodo`, `updateTodoSingle` and `updateTodo` are all
bound by it. Adding another way to write `completedAt` does not need new
enforcement — but removing that hook silently unbinds all three.

**Dependency edges have no generated mutations.** `features` in `tenancy.ts`
turns off insert/update/delete for `todoDependencies` so every edge goes through
`addTodoDependency`, which is where `assertNoCycle` lives.

**Report `NOT_FOUND`, never `FORBIDDEN`.** "You may not touch this" confirms the
row exists, which is itself something the caller is not entitled to know.

**`UNAUTHENTICATED` means the session expired.** The client drops its token on it
and redirects to `/login`. A bad magic link is `BAD_USER_INPUT` — it must not
sign anyone out.

## Code style

- Biome, single quotes, 2-space indent, 120 columns, trailing commas. `npm run check:fix`.
- `server/` and `db/` run under `--experimental-strip-types` with no build step,
  so **relative imports there carry an explicit `.ts` extension**. `app/` is
  bundled by Metro and omits it.
- **Never add `--preserve-symlinks`.** It resolves `@telos/db` to its path inside
  `node_modules`, and Node refuses to strip types from anything under there.
- The app writes DOM elements and Tailwind classes, not React Native primitives.
  `react-native` is imported only for `Platform`.
- `import './preflight.ts';` stays first in `server/src/index.ts`, separated by a
  blank line so Biome's import sorting leaves it there. It has to run before
  `@telos/db` is imported.
- Comments explain *why*. The code already says what.

## Generated output

`server/__generated__/`, `app/src/__generated__/` and `.env` are never committed.
Run `npm run codegen` after any schema change; CI regenerates from scratch.

## Git conventions

- Conventional Commits (`feat:`, `fix:`, `chore:`, …). semantic-release reads them.
- **Do not add `Co-Authored-By` trailers.**
- Never commit `.env`, generated code, or `node_modules`.
