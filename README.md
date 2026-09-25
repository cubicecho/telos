# Telos

A self-hostable todo app that is *just* todos.

Projects hold todos. Todos can depend on other todos, and a todo you are waiting
on is one you cannot tick off yet — Telos knows that and says so. Labels attach
to projects and todos alike. That is the whole product.

- **Projects** — a sidebar of them, each with open and total counts.
- **Todos** — a title, a checkbox, a delete button. Add one in a sentence and Enter.
- **Dependencies** — a blocked todo sits in its own section with its blockers
  named and its checkbox disabled. Cycles are rejected when you try to create them.
- **A board, or a list** — the same todos as columns you name yourself, one of
  which means done. Drag a card there and it is ticked off; tick the box and the
  card moves. Everything the drag does, a menu does too.
- **Labels** — one colour, one name, attachable to anything.
- **Sign-in by magic link**, or no link at all on a private instance.

## Quickstart

One container plus Postgres. The app and the API are served from the same
origin, so there is no second host to configure.

Nothing to clone and nothing to build. Make a directory, and save this in it as
`docker-compose.yml`:

```yaml
name: telos

services:
  telos:
    image: vantreeseba/telos:latest
    restart: unless-stopped
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      AUTH_SECRET: ${AUTH_SECRET:?generate one with `openssl rand -hex 32`}
      DATABASE_URL: postgres://telos:${POSTGRES_PASSWORD:?set a database password}@postgres:5432/telos
      # The address you actually reach Telos at. Magic-link URLs are built from
      # it, so a link to localhost is useless in an inbox.
      APP_URL: ${APP_URL:-http://localhost:3001}
      NODE_ENV: production
    ports:
      - "${PORT:-3001}:3001"

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: telos
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set a database password}
      POSTGRES_DB: telos
    # No `ports`: the database is for the app beside it on the compose network,
    # and nothing else needs to reach it.
    volumes:
      - telos_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U telos -d telos"]
      interval: 5s
      timeout: 5s
      retries: 10

volumes:
  telos_pgdata:
```

Generate the two secrets it refuses to start without, then bring it up:

```bash
printf 'AUTH_SECRET=%s\nPOSTGRES_PASSWORD=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > .env

docker compose up -d
```

Telos is on <http://localhost:3001>. Migrations run at boot, so there is no
setup step. Sign in with any email address — Telos ships no mail provider, so
the magic link goes to the log, and that is the delivery channel:

```bash
docker compose logs -f telos
```

Keep that `.env`. `AUTH_SECRET` is what sessions are signed with, and
`POSTGRES_PASSWORD` is the database's own. Your data lives in the
`telos_pgdata` volume, which survives `docker compose down`; upgrade with
`docker compose pull && docker compose up -d`.

Read [**Before you expose it**](#before-you-expose-it) before putting this on a
domain.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | **Required.** Postgres connection string. There is no embedded fallback. |
| `AUTH_SECRET` | — | **Required in production.** Signs sessions. `openssl rand -hex 32`. `JWT_SECRET`, its old name, is still read. |
| `APP_URL` | `http://localhost:3001` | Public URL; magic-link URLs are built from it. |
| `PORT` | `3001` | Port the server listens on. |
| `AUTH_MAGIC_LINK` | `true` | Set to `false` to sign in with an address alone, no link. |
| `EXPOSE_MAGIC_LINK` | dev only | Return the magic link in the API response so the login page can show it. |
| `AI_ENABLED` | — | Set to `false` to remove AI entirely: no MCP endpoint, no API keys, no agents, no switch in Settings. Otherwise an admin turns it on in Settings. |
| `RUNNER_CONCURRENCY` | `2` | The most runs the runner works at once. |
| `RUNNER_POLL_SECONDS` | `5` | How long the runner waits when nothing is ready. |
| `RUNNER_ALLOW_STDIO` | `false` | Let agents name MCP servers the runner spawns as commands. |
| `RUNNER_KEY` | made up at boot | Only for a second runner on another host (`runner/`, with `TELOS_URL`): set the same value on both. |

Telos ships no mail provider. With magic links on, the link is written to the
server log, and that is the delivery channel — pipe the log somewhere you can
read, or run with `AUTH_MAGIC_LINK=false`.

## AI

Telos is a board for people first, and AI is off unless you turn it on, at
every level:

1. **The instance**: Settings → AI → "AI on this instance", which only an
   admin sees. The first account to sign up is the admin; make another with
   `npm run admin -- --user <email>`. Off, the server's
   `/mcp` is a 404, no account can use AI, and the app shows none of it. To
   remove AI outright, so not even an admin can switch it on, set
   `AI_ENABLED=false`.
2. **The account**: Settings → AI. Off, the account's API keys stop working and
   nothing the runner does touches its rows.
3. **The project**: its AI switch. Off, the project takes no requests and its
   stations sit idle.
4. **The todo**: "AI ignores this". The runner leaves it alone.

With AI on there are two doors in. **`/mcp`** is for your own agents (Claude
Code and the like): with an API key from Settings they can submit requests,
read the board and add notes, but not move todos. **The runner** is telos's own
worker. A lane with an agent is a *station*: the runner claims a todo there,
has the agent work it, verify it, or split it into child todos, and telos moves
it along the lane's arrows. Each run keeps a log of its tool calls, which the
todo shows as it goes, and a list of what it made: files it wrote, and anything
the agent chose to record. An agent's MCP servers can carry hooks, for example
a memory lookup injected before each turn.

The runner is part of the server: it starts with it and signs itself in, so
there is nothing to set up. Until AI is on it only checks, every few seconds,
whether there is anything to do.

```bash
export AUTH_SECRET=$(openssl rand -hex 32)
docker compose up --build
# then, signed in as the admin: Settings → AI → switch on the instance, then your account
```

Agents talk to any OpenAI-compatible endpoint, so a local Ollama works. An
agent's base URL and its MCP servers are fetched from the server's host, so on
a shared instance keep it where it cannot reach anything private, and leave
`RUNNER_ALLOW_STDIO` off.

## Coming from kanban_server

Telos absorbs kanban_server's board. To bring one across, stop kanban_server
and point the importer at its database: its `DATABASE_URL`, or its PGlite
directory (`data/pg` by default). It writes to telos's `DATABASE_URL`, for the
account you name, which has to exist already (sign in once first).
A PGlite directory is opened with kanban_server's own PGlite, so run
`npm install` in kanban_server first; its data is newer than telos's PGlite
can read.

```bash
npm run import:kanban -- --from ../kanban_server/data/pg --user you@example.com --dry-run
npm run import:kanban -- --from ../kanban_server/data/pg --user you@example.com
```

`--dry-run` does the whole import, prints what it would write and rolls it
back. The import is one transaction: it lands whole or not at all.

What comes across:

- **Projects**, with their description and context. AI is **off** on every
  imported project, whatever `autoRun` said, so importing never starts an
  agent. Switch it on per project when you are ready.
- **Lanes**, in order. kanban_server has no done flag, so the lane named
  Done (or Complete, Finished, Shipped, Closed) becomes the done lane; a board
  without one gets none, and you can mark one in telos. A lane's role becomes
  its contract, the role's prompt and the lane's own are joined, and the
  success and failure arrows, WIP limit and attempts carry over. A lane that
  archived on success now sends to the done lane.
- **Agents**, with settings they inherited from kanban_server's Settings
  written onto them, and their MCP servers. An agent with the same name
  already in telos is used as is rather than copied again.
- **Cards** become todos, with body as notes, acceptance, parent, lane and
  order. Cards in the done lane, and archived cards, arrive completed.
- **Dependencies**, **notes** (note, report, verdict) and the **card history**,
  as todo history.

What does not: **runs** and their artifacts, **tasks** and their message
threads, and **secrets**: no API keys, and no MCP server headers or env
(where tokens live). The summary names each one left behind so you can
re-enter it. It also lists any dependency it had to drop to keep telos's rules,
such as a done card still waiting on an open one.

A project whose name you already have is refused, and nothing is written.
`--rename` imports it as "Name (kanban)" instead.

Once imported and checked, kanban_server can be retired: telos has the board,
and nothing reads the old database again.

## Before you expose it

Registration is **open**: any address that completes a sign-in gets an account.
That is the right default for an instance only you can reach, and the wrong one
for an instance on the public internet. Before putting Telos on a domain:

- **Put it behind something.** A reverse proxy with TLS, and — if the instance is
  yours alone — an allowlist, VPN, or auth in front of it. Telos rate-limits
  sign-in requests per address in process; per-IP limiting is the proxy's job,
  because the proxy is the only thing that reliably knows the client's address.
- **Never set `AUTH_MAGIC_LINK=false` on a reachable instance.** It makes an email
  address the entire credential: anyone who can load the login page can sign in
  as anyone.
- **Never set `EXPOSE_MAGIC_LINK=true` on a reachable instance.** It hands the
  sign-in token to whoever asked for it, which is the same thing by another route.
- **Set a real `AUTH_SECRET`** and keep it. Leaking it lets anyone forge a
  signed session cookie. The server refuses to boot in production while it is
  unset or still the default.

## Development

```bash
git clone https://github.com/cubicecho/telos.git
cd telos

cp .env.example .env
sed -i "s/^AUTH_SECRET=.*/AUTH_SECRET=$(openssl rand -hex 32)/" .env

npm install
npm run db:up          # Postgres on 127.0.0.1:5435
npm run db:migrate
npm run codegen
npm run dev            # API (and its runner) on 3001, Expo dev server on 3000
```

`npm run check` runs codegen, Biome and `tsc --noEmit` across every
workspace; `npm test` runs the suite against an in-memory Postgres. See
[AGENTS.md](AGENTS.md) for how the pieces fit together.

If the server starts with `Cannot reach Postgres`, check whether your Docker
daemon is this machine:

```bash
docker context ls
```

A remote endpoint (`ssh://…`, `tcp://…`) means `npm run db:up` published the
database on *that* host's `127.0.0.1`, where nothing else can reach it. Set
`POSTGRES_BIND=0.0.0.0` in `.env`, point `DATABASE_URL` at the daemon's
hostname, and re-run `npm run db:up`. Only on a network you trust — the dev
database has a throwaway password and no TLS.

### Building the image

The repo ships its own `docker-compose.yml`, which builds the image rather than
pulling it and publishes Postgres on `127.0.0.1:5435` so you can point your own
tooling at it:

```bash
export AUTH_SECRET=$(openssl rand -hex 32)
docker compose up --build
```

## License

[MIT](LICENSE) © Benjamin Van Treese
