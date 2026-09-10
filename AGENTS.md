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
│   │       └── settings/index.tsx  # Theme + label management
│   ├── src/
│   │   ├── __generated__/   # Generated GraphQL types (do not edit, not committed)
│   │   ├── components/
│   │   │   ├── ui/          # shadcn/ui primitives — no app logic
│   │   │   ├── domain/      # project/, todo/, lane/, label/, settings/
│   │   │   └── layouts/     # sidebar
│   │   └── lib/             # apollo, auth, theme, cache writers, blocking, graphql documents, cn()
│   ├── public/index.html    # HTML shell; applies the theme before first paint
│   ├── app.json             # Expo config
│   ├── metro.config.js
│   └── tailwind.config.js
├── server/                  # GraphQL API (port 3001)
│   ├── __generated__/       # Generated SDL + resolver types (not committed)
│   └── src/
│       ├── index.ts         # Entry point: migrate, mount /graphql, serve the SPA
│       ├── preflight.ts     # Boot guards — imported first, on purpose
│       ├── build-schema.ts  # createSchema(db) — buildSchema + extensions
│       ├── schema.ts        # Binds createSchema to the real database
│       ├── tenancy.ts       # Row scope + server-owned columns, as buildSchema config
│       ├── blocking.ts      # The dependency rules, in one place
│       ├── lanes.ts         # The lane rules, in one place
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
npm run dev              # server (3001) + Expo dev server (3000)
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
- **Generated names say their arity.** `typeNameMapper: 'singularize'` maps the
  plural table key onto a singular type, and the noun is what tells the two
  forms of an operation apart: `todos` / `todo` for reads, `createTodos` /
  `createTodo`, `updateTodos` / `updateTodo`, `deleteTodos` / `deleteTodo` for
  writes. The plural form filters and returns a list; the singular takes a
  required `where` and returns one row or null. `deleteTodo(where: …)` deletes
  one row — reach for `deleteTodos` when you mean every match.

## Rules that carry weight

**Every table needs a `scope` entry.** `server/src/tenancy.ts` maps each table to
a `RowScope` that is ANDed into the SQL of every generated read, update and
delete. A table missing from `scope` is visible across tenants, and nothing else
in the code will say so. `tenancy.test.ts` fails when you forget — do not delete
the test to make it pass.

**`scope` cannot reach a plain insert.** Any foreign key a caller can state gets
checked in an `onWrite` hook in `server/src/resolvers/write-guards.ts`. A new
table with a user-facing FK needs an entry in `FOREIGN_KEYS`.

**A blocked todo cannot be completed, and cannot change lane.** The rule is an
invariant, not a code path: `assertNoBlockedCompletions` re-checks it after any
write that sets `completedAt`, so `completeTodo`, `updateTodo` and `updateTodos`
are all bound by it. Adding another way to write `completedAt` does not need new
enforcement — but removing that hook silently unbinds all three. `moveTodo`
checks the same rule for a change of column, because the done lane was only the
sharpest case of it: work waiting on something else has no business being
advanced across the board either. Two exemptions, both about not stranding a
card — a completed todo can always be dragged back out of the done lane, since
that is how it gets reopened, and reordering a blocked todo inside its own column
is free. `laneLock()` in `app/src/lib/lanes.ts` states the client's half, and it
disables the drag and the "Move to" entries rather than letting either fail at
the server.

**The lane and the checkbox say the same thing.** In a project that has a done
lane, a todo with a lane is completed *if and only if* that lane is the done one.
`server/src/lanes.ts` states the biconditional and keeps it: `moveTodo`,
`completeTodo`, `reopenTodo` and `setDoneLane` each maintain it directly, and
`assertCompletionMatchesLane` re-asserts it after any generated write — so
dropping a card in the done column ticks it off, ticking the box moves the card,
and neither view can be made to disagree with the other. A generated write that
*states completion* has its lane realigned to match (completion is the fact, the
lane is how it is drawn); one that names only a lane is refused and pointed at
`moveTodo`, because guessing which of the two the caller meant would silently
undo the other. A project with no done lane is exempt: its board simply has no
column that means done. Every project has at least one lane — `seedMissingLanes`
runs in the transaction that creates it, and deleting the last one is refused.
`isDone` is reserved for `setDoneLane`, and the partial unique index
`uq_lanes_project_done` makes "at most one done lane per project" structural
rather than a rule someone has to remember.

**`position` is project-wide, not per-lane.** One sequence orders the list view
and every column of the board, so the two tabs cannot disagree about what comes
first. A drop names an index *within a column*; `reposition()` in
`server/src/resolvers/lanes.ts` and `moveTodoInList()` in `app/src/lib/lanes.ts`
translate that into the global sequence, and they translate it the same way — if
they drift, the board reshuffles itself on the next fetch. Lane `position` has
deliberately no unique constraint: reordering rewrites several lanes in one
statement and a unique index would reject the intermediate state.

**Dragging is never the only way.** `@dnd-kit` gives the board its pointer
gesture, and a pointer is the only thing it gives. Every move it offers exists
again as a menu: `LanePicker` ("Move to") on each todo row and each card, and the
lane header's own menu for renaming, reordering, the done flag and deletion. A
board action added without a keyboard route is a board action half the people
using it cannot reach.

**Dependency edges have no generated mutations.** `features` in `tenancy.ts`
turns off insert/update/delete for `todoDependencies` so every edge goes through
`addTodoDependency`, which is where `assertNoCycle` lives.

**Report `NOT_FOUND`, never `FORBIDDEN`.** "You may not touch this" confirms the
row exists, which is itself something the caller is not entitled to know.

**`UNAUTHENTICATED` means the session expired.** The client drops its token on it
and redirects to `/login`. A bad magic link is `BAD_USER_INPUT` — it must not
sign anyone out.

**The palette is the other cubicecho apps'.** `app/global.css` carries the same
tokens their `index.css` does — the neutral shadcn set, one done colour, a
`--sidebar` group and `--radius: 0.625rem`. They are on Tailwind v4 and write it
in oklch; NativeWind pins this app to v3, whose colour plumbing is
`hsl(var(--token))`, so the identical colours are written here as HSL triples.
Same values, different notation. The two exceptions are `--border` and `--input`
in dark, which are white at 10% and 15% there and are composited over the
background here, because these tokens carry no alpha channel.

**The theme is applied twice, on purpose.** `app/public/index.html` sets `.dark`
on `<html>` before the bundle loads so there is no white flash, and
`src/lib/theme.ts` maintains it afterwards. The storage key `telos_theme` and the
class rule are written out in both places — the script runs before any module
exists — so a change to one is a change to both. That HTML file is also Expo's
own template with a script added: `app/+html.tsx` is the documented place for
this and does nothing under `web.output: "single"`.

**A write returns the entity it changed, not the row it wrote.** Attaching a
label and adding a dependency are junction-table inserts, but what the screen
reads is the *todo* — its `labels`, its `dependencies`, its `blockedBy` — so
those mutations select `todo { ...TodoFields }` off the junction row (and
`project { ...ProjectLabelFields }` for a project's labels). Apollo normalizes by
id, so one full selection settles every list and screen already holding that
entity and nothing has to refetch to find out what the write did. The catch is
that a field's *arguments* are part of the key it is cached under: `labels` is
selected with the same `orderBy` everywhere, which is why it lives in a shared
fragment rather than being spelled out per document. A selection that omits a
field the query reads leaves that field stale, so widen the fragment rather than
the document.

**Creates carry a client-generated id.** `newId()` in `src/lib/ids.ts` mints the
UUID, the create mutation sends it in `values`, and Postgres keeps it. That is
what lets a new row be written to the cache before the request leaves: the
optimistic entry and the server's are the same normalized object, so nothing
remounts and a tick applied in between names an id the server will recognise.
The three list fragments in `src/lib/graphql.ts` exist for the same reason — a
create returns exactly what its list stores, so the cache never holds a
half-written entity. A field added to a list is a field the create must return,
which sharing the fragment makes automatic. `newId()` does not assume
`crypto.randomUUID`: it is secure-context-only and Telos runs on plain http.

**The todo list writes itself, and rederives blocking.** Creating, completing,
reopening and deleting a todo are optimistic: the mutation carries an
`optimisticResponse` and an `update` that edits the cache directly, so the row
moves on the click rather than on the round trip. Every one of those edits goes
through `updateProjectTodos()` in `src/lib/cache.ts`, which applies the one
change the mutation made and then hands the whole list to `resolveBlocking()` in
`src/lib/blocking.ts`. That is deliberate: `isBlocked` and `blockedBy` are
server-derived, and ticking one todo off can unblock several others, so a patch
that touched only the named row would leave the rest of the list lying.
`resolveBlocking` reapplies the server's own rule — blocked while any dependency
is still open — and is idempotent, because Apollo runs `update` twice (once
optimistically, once on the real result). Counts move through
`bumpProjectCounts()`, a delta, which is safe for the same reason: the
optimistic layer is discarded before the real pass.

**Text on a user-chosen colour picks its own ink.** A label's colour comes out of
the database, so no Tailwind variant and no theme token can be trusted to read on
it — `readableTextColor()` in `src/lib/readable-text-color.ts` compares the two
WCAG contrast ratios and returns absolute black or white. Absolute, not
`--foreground`: the backdrop is the user's colour and does not flip with the
theme, so the ink must not either. It returns `undefined` for anything it cannot
parse, which leaves the inherited colour in place rather than painting black onto
a value it failed to read.

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
