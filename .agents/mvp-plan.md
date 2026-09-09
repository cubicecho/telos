# Telos — scaffold a self-hostable todo app at `apps/todo`

## Context

`apps/todo/` is empty. It should become **Telos** — a standalone, self-hostable todo
app that is *just* todos: projects, todos with dependencies, and labels. It sits
alongside `philotes`, `auto-cal`, `eunomia`, `notes` and `personal-dashboard`, each of
which is its own git repo under `github.com/cubicecho` (there is no workspace root at
`cubicecho/`, no root `package.json`, and `cubicecho/` is not itself a repo).

The intended outcome is a repo a stranger can `docker compose up` and use, and that a
philotes contributor can read without relearning anything. So the scaffold follows the
philotes/auto-cal house pattern deliberately rather than inventing a stack.

**Decisions already made (do not revisit):**

| | |
| --- | --- |
| Name | **Telos** — repo `cubicecho/telos`, image `vantreeseba/telos`, packages `@telos/{app,server,db}` |
| Frontend | Expo Router (web target) + NativeWind + Apollo Client, exactly like philotes. **Not** cubeui — it needs Tailwind v4, philotes/NativeWind is v3 |
| Database | **Postgres only.** `DATABASE_URL` required; server refuses to boot without it. PGlite appears only as a test fixture |
| Registration | Open signup — any email that completes a magic link gets an account |
| Dependencies | **Blocking.** A todo with an incomplete dependency cannot be completed; cycles rejected on create |
| Email | None. The magic link is logged to the server console and returned in the API response when exposure is enabled. No mail library |
| Plan doc | `.agents/mvp-plan.md`, not the repo root — house rule in philotes/notes/auto-cal |
| Commits | Conventional Commits. **No `Co-Authored-By` trailers** (philotes AGENTS.md rule, which overrides my session default here) |
| Port | **3002** — 3000 is personal-dashboard, 3001 is philotes and auto-cal, 4000 is eunomia. Compose Postgres on **5435** (eunomia owns 5433) |

## Architecture

Three npm workspaces in one repo, mirroring philotes:

```
apps/todo/
├── db/       @telos/db      Drizzle schema + relations + migrations
├── server/   @telos/server  Express 5 + Apollo Server 5, GraphQL
└── app/      @telos/app     Expo Router web client
```

The load-bearing idea, inherited from philotes: **the GraphQL schema is generated from
the Drizzle schema** by `@vantreeseba/drizzle-graphql`'s `buildSchema()`. There are no
hand-written CRUD resolvers. Multi-tenancy is *configuration* (`scope` + `contextValues`
handed to `buildSchema`), not resolver wrappers — `scope` is ANDed into the SQL of every
generated read, and `contextValues` strips `userId` from every input and stamps it from
the request. Only what CRUD cannot express gets a hand-written resolver.

One deviation from philotes, taken from auto-cal: `@telos/db` exports raw `.ts` through
its `exports` map rather than compiling to `dist/`. Philotes' own AGENTS.md warns twice
about the "rebuild db before codegen" footgun; skipping the build step removes it.

## Data model — `db/src/models/*.ts`

One file per table, barrel-exported from `db/src/schema.ts`, relations in
`db/src/relations.ts` via `defineRelations`. `uuid().primaryKey().defaultRandom()`,
`snake_case` columns, `camelCase` in Drizzle, `index()` on every FK.

- **`users`** — `id`, `email` (unique), `name`, `createdAt`, `updatedAt`. No password column; magic link is the only credential.
- **`projects`** — `id`, `userId`, `name`, `description`, `archivedAt`, `createdAt`, `updatedAt`.
- **`todos`** — `id`, `userId`, `projectId` → projects (cascade), `title`, `completedAt`, `position` (integer, for ordering), `createdAt`, `updatedAt`. Title only, per the brief; the columns to expand into later are notes/dueAt.
- **`todoDependencies`** — `id`, `userId`, `todoId` (the blocked one), `dependsOnTodoId` (the blocker), `createdAt`. `unique(todoId, dependsOnTodoId)`.
- **`labels`** — `id`, `userId`, `name`, `color`, `createdAt`. `unique(userId, name)`.
- **`projectLabels`** — `id`, `userId`, `projectId`, `labelId`. `unique(projectId, labelId)`.
- **`todoLabels`** — `id`, `userId`, `todoId`, `labelId`. `unique(todoId, labelId)`.

Every table carries `userId`, junctions included. Philotes routes junction ownership
through a parent-row subquery (`tenancy.ts` `JUNCTION_PARENTS`); carrying the column
directly is simpler and lets every table use the same one-line `scopeByUserId`. The
tradeoff — a caller could name someone else's `todoId` on insert, since `scope` cannot
reach a plain insert — is closed by the `onWrite` hooks below, which philotes needs
anyway.

Relations in `relations.ts` must include `todos.dependencies` / `todos.dependents`
(both through `todoDependencies`) and the `labels` many-to-many via `.through()`, since
**`relations.ts`, not the table list, is what drizzle-graphql reads** — a table with no
relations entry gets no relation fields in the API.

## Server — `server/src/`

Follow `apps/philotes/server/src/` file-for-file where the concern is the same.

- **`index.ts`** — boot guard (exit if `JWT_SECRET` is unset/default under production, or if `DATABASE_URL` is unset at all), run pending migrations, mount `/graphql`, mount the SPA static handler + fallback, listen on `PORT` / `0.0.0.0`.
- **`routes/graphql.ts`** — Apollo Server 5 via `@as-integrations/express5`; `context: async ({ req }) => ({ db, userId: extractUserId(req) })`. Copy the shape from philotes.
- **`static.ts`** — serve `app/dist` with a path-traversal guard, `immutable` cache for `/assets/*`, SPA fallback to `index.html`. Model on `apps/eunomia/apps/server/src/static.ts` (~60 lines). This is what makes one container the whole deployment, so magic links need no second origin.
- **`resolvers/auth.ts`** — port `apps/philotes/server/src/resolvers/auth.ts` nearly verbatim: `signToken` (30d, `{ userId }`), `signMagicToken` (15m, `{ email }`), `verifyToken`, `extractUserId`, `requireAuth`, and an `extendSchema` block adding `requestMagicLink` / `verifyMagicLink`. Changes from philotes:
  - `RequestMagicLinkResult { ok: Boolean!, magicLink: String, token: String, userId: ID }`. When `AUTH_MAGIC_LINK=false`, `requestMagicLink` upserts the user and returns a live session `token`/`userId` immediately — the client keeps one code path and simply stores whatever it gets.
  - `magicLink` is returned when `EXPOSE_MAGIC_LINK` is truthy, defaulting to `NODE_ENV !== 'production'` (auto-cal's `magicLinkExposed()` in `server/src/config.ts` is the reference). The link is always `console.log`ged.
  - Rate-limit `requestMagicLink` — it is an unauthenticated oracle. An in-process fixed-window counter is enough; `apps/eunomia/apps/server/src/rate-limit.ts` is the model.
- **`tenancy.ts`** — `scope`, `contextValues`, `exclude`, `features`, shaped like philotes'. Every table gets `scopeByUserId`; `users` scopes on `id`. `features` denies generated insert/update/delete on `users` (auth owns that lifecycle) and on `todoDependencies` (the custom mutations own it, so cycle checking cannot be bypassed).
- **`blocking.ts`** — the dependency rules, in one place:
  - `isBlocked(db, todoIds)` — one batched query returning the set of ids having at least one incomplete dependency: `SELECT d.todo_id FROM todo_dependencies d JOIN todos t ON t.id = d.depends_on_todo_id WHERE d.todo_id = ANY($1) AND t.completed_at IS NULL`. Wrap in a per-request `DataLoader` on the context so `Todo.isBlocked` over a list is one query, not N.
  - `assertNoCycle(db, todoId, dependsOnTodoId, userId)` — reject self-dependency, then a recursive CTE walking `dependsOnTodoId`'s own dependencies; if `todoId` is reachable, throw `BAD_USER_INPUT`.
- **`resolvers/todos.ts`** — `extendSchema` adding:
  - `Todo.isBlocked: Boolean!` and `Todo.blockedBy: [Todo!]!`
  - `Project.todoCount: Int!` and `Project.openTodoCount: Int!` (the project overview's numbers)
  - `completeTodo(id: ID!): Todo!` / `reopenTodo(id: ID!): Todo!`
  - `addTodoDependency(todoId: ID!, dependsOnTodoId: ID!): Todo!` / `removeTodoDependency(todoId: ID!, dependsOnTodoId: ID!): Todo!`
- **`resolvers/write-guards.ts`** — the `onWrite` hooks passed to `buildSchema`, covering the two things `scope` structurally cannot:
  1. **Ownership on insert.** Any FK a caller can state (`projectId`, `todoId`, `labelId`, `dependsOnTodoId`) is verified to belong to `requireAuth(ctx)`. Philotes' `server/src/resolvers/junction-ownership.ts` is the reference for the hook's signature and shape.
  2. **Blocking on completion.** A write to `todos` that sets `completedAt` non-null goes through the same guard `completeTodo` uses. Enforcing at the write boundary rather than only in the ergonomic mutation means the generated `updateTodo` cannot route around it.
  > Read the `onWrite` and `RowScope` types out of `@vantreeseba/drizzle-graphql` v9 (and philotes' usage) before writing these — the signature is the one thing here not already pinned down by an existing file.
- **`schema.ts`** — `buildSchema(db, { prefixes: { insert:'create', update:'update', delete:'delete' }, typeNameMapper: 'singularize', scope, contextValues, exclude, features, onWrite })`, then apply the auth and todo extensions in order. Copy philotes' `schema.ts` structure exactly.

Errors follow the house vocabulary: `GraphQLError` with `extensions.code`; `UNAUTHENTICATED`
only for session expiry (the client drops the token on it), `BAD_USER_INPUT` for a bad
magic link or a cycle, and **`NOT_FOUND` rather than `FORBIDDEN`** for a row the caller
may not see.

## Client — `app/`

Expo Router web target, mirroring `apps/philotes/app/`: `app.json`, `babel.config.js`
(module-resolver `@` → `./src`), `metro.config.js`, `tailwind.config.js` (nativewind
preset, shadcn HSL vars, `tailwindcss-animate`), `postcss.config.js`, `components.json`,
`codegen.ts`, `global.css`. Write DOM elements and Tailwind classes, not React Native
primitives — `react-native` is imported only for `Platform`.

Routes (`app/app/`, which is *not* `app/src/`):

| Route | Contents |
| --- | --- |
| `_layout.tsx` | ApolloProvider (auth link + `onError` clearing the token on `UNAUTHENTICATED`) + Stack |
| `login.tsx` | Email field → `requestMagicLink`. Renders the returned link when exposed; signs straight in when a `token` comes back |
| `auth/verify.tsx` | Fires `verifyMagicLink` once behind a `useRef` guard, stores the token, `router.replace`s in |
| `(app)/_layout.tsx` | `if (!isAuthenticated()) return <Redirect href="/login" />`, then the sidebar shell |
| `(app)/index.tsx` | Redirect to the first project, or the empty state |
| `(app)/projects/[id].tsx` | Project overview + todo list |
| `(app)/labels/index.tsx` | Label management |

`src/lib/auth.ts` is philotes' four-function module with the key renamed `telos_token`.

Components under `src/components/`:
- `ui/` — shadcn primitives copied in (button, input, checkbox, dialog, alert-dialog, card, badge, label, select, skeleton). No app logic.
- `layouts/sidebar.tsx` — the persistent project list, with a "new project" action and a link to labels.
- `domain/project/` — `project-list-item`, `project-overview` (name, description, open/total counts, labels), `project-form-dialog`.
- `domain/todo/` — `todo-row` (checkbox to complete, delete button, label badges, a "blocked by N" affordance), `todo-form-dialog`, `dependency-picker`.
- `domain/label/` — `label-badge`, `label-picker`, `label-form-dialog`.

The project screen shows the overview, then **open, unblocked todos**, then a separate
dimmed **Blocked** section — the completion checkbox is disabled there with the blocking
todos named. Done todos live behind a "show completed" toggle.

Data fetching is Apollo hooks with typed documents from the `client` preset (`graphql()`
helper from `@/__generated__`), and `refetchQueries` on every mutation that changes a list.

## Repo scaffolding

Root files, taking philotes' versions as the base:

- `package.json` — `"type": "module"`, `"workspaces": ["app","server","db"]`, `overrides` pinning `graphql` and `drizzle-orm`. Scripts: `dev`, `dev:app`, `dev:server`, `build`, `codegen`, `check`, `check:biome`, `check:types`, `lint`, `lint:fix`, `format`, `test`, `test:watch`, `db:generate`, `db:migrate`, `db:studio`, `db:up`, `db:down`.
- `biome.json` — copy philotes' **Biome 2.4.6** config verbatim (it is the current one; auto-cal and personal-dashboard are still on 1.9.4). Single quotes, 2-space, 120 width, trailing commas, `useImportType: error`, `noUnusedImports/Variables: error`, `organizeImports` on.
- `tsconfig.json`, per-workspace `tsconfig.json`. Strict. `server/` and `db/` run under `--experimental-strip-types`, so **relative imports there carry an explicit `.ts` extension**; `app/` is bundled by Metro and omits it.
- `vitest.config.ts` — root config, `globals: true`, alias `@` → `app/src`, `env: { DATABASE_URL: '' }` so a test that forgets to stub the db fails loudly (auto-cal's trick).
- `Dockerfile` — two stages on `node:24-alpine`. Build: `npm ci`, `npm run codegen`, `expo export --platform web`. Runtime: `npm prune --omit=dev`, `CMD ["node","--experimental-strip-types","server/src/index.ts"]`. No `dist` for the server; TypeScript runs directly.
- `docker-compose.yml` — `telos` + `postgres:17` with a healthcheck and a named volume, Postgres bound to `127.0.0.1:5435`. `JWT_SECRET: ${JWT_SECRET:?...}` so compose refuses to start without a real secret.
- `.env.example` — `DATABASE_URL` (required), `JWT_SECRET`, `APP_URL`, `PORT`, `AUTH_MAGIC_LINK`, `EXPOSE_MAGIC_LINK`, `EXPO_PUBLIC_API_URL`, each with the comment explaining it. Model on philotes' and eunomia's.
- `.gitignore` — `node_modules`, `dist`, `.env`, `__generated__`, `.expo/`, `pgdata/`, `**/tsconfig.tsbuildinfo`. **Codegen output is never committed.**
- `.dockerignore`, `.releaserc.json` (semantic-release on `main`).
- `.github/workflows/ci.yml` — `npm ci` → `codegen` → `check:types` → `lint` → `test`. (Philotes has no CI job; auto-cal and eunomia do, and a new repo should.)
- `AGENTS.md` — the canonical agent doc: stack table, structure, commands, code style, the tenancy rule ("a new table needs a `scope` entry or it is visible across tenants"), the dependency rule, and the git conventions including *no `Co-Authored-By` trailers*.
- `CLAUDE.md` — `Use AGENTS.md instead.`
- `README.md` — what it is, screenshots placeholder, **Self-hosting** (compose quickstart, generating `JWT_SECRET`, the `AUTH_MAGIC_LINK=false` no-email mode), and **Before you expose it**.
- `.agents/mvp-plan.md` — this plan, written into the repo.

## Order of work

1. `git init` on `main`; root scaffolding files (`package.json`, `biome.json`, tsconfigs, `.gitignore`, `.env.example`).
2. `db/` — models, relations, `drizzle.config.ts`, `src/index.ts` (postgres-js, throws if `DATABASE_URL` is unset), generate the initial migration.
3. `server/` — auth, tenancy, blocking, write guards, schema, routes, static, index. Codegen wired.
4. `app/` — Expo config, Apollo client, auth lib, routes, then components inward-out.
5. Tests (below), then `Dockerfile` / `docker-compose.yml` / CI.
6. Docs: `AGENTS.md`, `CLAUDE.md`, `README.md`, `.agents/mvp-plan.md`.
7. One initial commit, Conventional Commits style, no trailers. Creating `cubicecho/telos` on GitHub is a separate step I'll ask about rather than assume.

## Verification

Tests (Vitest, in `server/src/__tests__/`). Do **not** import `@telos/db` from a test —
it opens a real connection at import. Build a throwaway in-memory Postgres per suite with
`new PGlite('memory://')` and `pushSchema`, the way `apps/eunomia/apps/server/test/helpers/test-db.ts`
does.

- `tenancy.test.ts` — every table in the schema has a `scope` entry. Ported from philotes; it is the test that fails when someone adds a table and forgets tenancy.
- `blocking.test.ts` — a todo with an incomplete dependency reports `isBlocked` and refuses completion through *both* `completeTodo` and the generated `updateTodo`; completing the blocker unblocks it.
- `dependencies.test.ts` — self-dependency rejected; a direct cycle rejected; a transitive cycle (A→B→C→A) rejected; a diamond (not a cycle) accepted.
- `auth.test.ts` — magic token round-trips; an expired/garbage token throws `BAD_USER_INPUT`; verifying creates the user on first use and reuses it on second; with `AUTH_MAGIC_LINK=false`, `requestMagicLink` returns a live session token.
- `write-guards.test.ts` — a todo cannot be created against another user's `projectId`; a label cannot be attached across users.

End-to-end, by hand:

```bash
cp .env.example .env && sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env
npm ci
npm run db:up          # postgres:17 on 127.0.0.1:5435
npm run db:migrate
npm run codegen
npm run check          # codegen + biome + tsc --noEmit
npm test
npm run dev            # server 3002, expo 3004
```

Then in the browser: sign in at `/login` (the magic link prints to the server console and
renders on the page in dev) → create a project → it appears in the sidebar → open it and
see the overview with counts → add three todos → make one depend on another and confirm
it lands in the dimmed **Blocked** section with its checkbox disabled → complete the
blocker and confirm the blocked todo becomes checkable → try to create a cycle and get a
readable error → create a label, attach it to both a project and a todo → delete a todo.

Then the self-host path, which is the actual product:

```bash
docker compose up --build     # http://localhost:3002 — one container + postgres
```

Confirm migrations ran at boot, the SPA is served from the same origin as `/graphql`,
a magic link works end to end, and `AUTH_MAGIC_LINK=false` logs you in with no link at all.

## What changed while building it

The plan above is what was agreed; these are the places the implementation
departed from it, and why.

- **No `--preserve-symlinks`.** The plan's Dockerfile `CMD` carried it, copied
  from philotes. It resolves `@telos/db` to its path inside `node_modules`, and
  Node refuses to strip types from anything under there
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Dropped everywhere.
- **Blocking is enforced as an invariant, not on the touched rows.** The plan had
  the `onWrite` hook check the rows a write returned. A GraphQL mutation returns
  only the columns the client selected, so `completedAt` is usually absent and
  the check silently passed. `assertNoBlockedCompletions` re-asserts "no
  completed todo of this caller's waits on an open one" instead, which is
  independent of the selection set. One consequence worth knowing: a single write
  that completes a blocker *and* its dependent together is allowed, because the
  state it leaves behind is consistent.
- **`Context` lives in its own module.** Philotes defines it in
  `routes/graphql.ts`, which here would have made `resolvers/auth.ts` and the
  route file import each other.
- **Schema building is split in two.** `build-schema.ts` takes a `db`;
  `schema.ts` binds it to the real one. Tests must not import `@telos/db`, which
  opens a connection at import time.
- **`graphql` is pinned to its CommonJS entry point in `vitest.config.ts`.** The
  package ships no `exports` map, so Vite follows `module` to `index.mjs` while
  Node follows `main` to `index.js`; a schema built on one copy fails the
  `instanceof` checks of the other.
- **Dev ports moved to 5435 and 3004.** The plan picked 5434 for Postgres and
  3000 for the Expo dev server; both were already taken on the development
  machine (by the shared `cubicecho-postgres` and by `cubicecho-dashboard`).
- **No `exclude` in `tenancy.ts`.** Philotes needs it to keep `passwordHash` off
  the API. Telos has no password column — the magic link is the only credential.
- **TLS is decided from the parsed hostname, not the connection string.** The
  first cut matched `postgres://(localhost|127.0.0.1|postgres)` against the raw
  URL. A URL with credentials (`postgres://telos:telos@postgres:5432/telos`)
  puts the userinfo exactly where that match looks for the host, so compose's
  own database was classified as remote and the container crash-looped on
  `ECONNRESET` trying to speak TLS to a plaintext Postgres. `requiresSsl()` now
  parses the URL, honours an explicit `sslmode` as the operator's decision, and
  treats loopback and dotless service names as local.
