# Telos

A self-hostable todo app that is *just* todos. Site:
<https://cubicecho.github.io/telos/>

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
| `APP_URL` | `http://localhost:3001` | Public URL; magic links and each todo's and project's `url` (`/todos/<id>`, `/projects/<id>`, for other apps to link back) are built from it. |
| `PORT` | `3001` | Port the server listens on. |
| `AUTH_MAGIC_LINK` | `true` | Set to `false` to sign in with an address alone, no link. |
| `EXPOSE_MAGIC_LINK` | dev only | Return the magic link in the API response so the login page can show it. |
| `AI_ENABLED` | — | Set to `false` to remove AI entirely: no MCP endpoint, no API keys, no agents, no switch in Settings. Otherwise an admin turns it on in Settings. |
| `RUNNER_CONCURRENCY` | `2` | The most runs the runner works at once. |
| `RUNNER_POLL_SECONDS` | `5` | How long the runner waits when nothing is ready. |
| `RUNNER_ALLOW_STDIO` | `false` | Let the runner spawn MCP servers that are commands. |
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
   nothing the runner does touches its rows. On, Settings gains two tabs:
   **Agents** (the agent defaults, the agents and the lane presets) and
   **MCP servers**.
3. **The project**: its AI switch. Off, the project takes no requests and its
   stations sit idle.
   Under it is a second switch, **auto-run**: whether the project's stations
   start on todos by themselves. It is off on a new project, so switching AI on
   starts nothing. Off, a station works a todo only when you ask: **Run now**,
   on its card or in its Runs tab, has the station it stands in work it once.
   It then follows the lane's arrow and waits again. Switching auto-run off
   lets what is running finish.
4. **The todo**: "AI ignores this". The runner leaves it alone.

With AI on there are two doors in. **`/mcp`** is for your own agents (Claude
Code and the like): with an API key from Settings they can read the board and
what happened on it (lanes, runs and their logs, history, notes, blockers,
spend, artifacts, drafts, templates, and the agents without their keys), and
work it: make and rename projects, add, edit, move, retry, run, stop, archive,
restore and delete todos, set what they wait on, talk a todo over in a draft,
write notes, record what they made for a todo (`record_artifact`: where it is
and what to call it), and save or apply a board template. Each key has a switch
per tool in Settings, all on until you turn one off; a tool that is off is
neither offered to the key nor allowed to it, so a read-only key is one with
its writing tools off. The AI switches, agents, keys, lanes and stations, bulk
changes and deleting a project stay yours. Nothing checks what a client
records, so the board lists it as unverified, signed with the key that said it. **The runner** is telos's own
worker. A lane with an agent is a *station*: the runner claims a todo there,
has the agent work it, verify it, or split it into child todos, and telos moves
it along the lane's arrows. A new agent can start from one of four templates
(Settings → Agents → From template): a **Refiner** for drafts, a **Planner** for
Expand stations, a **Worker** for Work stations and a **Reviewer** for Verdict
ones. Each comes with a prompt and a temperature for its job; give it a base URL
and a model, or leave those to your agent defaults. An agent's form, like the
defaults', starts at its endpoint: type the base URL (and a key, if it wants
one) and its models are listed, to pick from, with the context length each
reports; an endpoint that lists nothing still takes a model typed by name.
A reasoning effort (off, or a level from none to max) is sent as
`reasoning_effort` to a model that deliberates; an agent can turn off a level its
defaults ask for. A station can archive what passes instead of
moving it: the todo is completed and leaves the board, for a pipeline whose
finished work nobody needs to see in a column. Stations that do the same job
can follow one **lane preset** (Settings → Agents): its contract, prompt, WIP limit
and attempts. A lane keeps its own value for any field it overrides and follows
the preset for the rest, and its own prompt is added after the preset's. A
preset lists the lanes following it and what each overrides; deleting it copies
its values into them first. It claims by itself in a project with auto-run on,
and only the todos you asked for in one with it off. Each run keeps a log of its tool calls, which the
todo shows as it goes, and a list of what it made: files it wrote, and anything
the agent chose to record. What was made for a todo outlives it: delete the
todo for good and its artifacts stay on the project's Artifacts list, under the
title the todo had, until you remove them or delete the project. **MCP
servers** are kept once, under Settings → MCP servers, and each agent reaches every one
of them or only the ones you tick. A server's headers and environment are
secrets: you can see which are set, never their values, and only the runner is
sent them. Test a server there and it keeps what it found, so the list shows
which servers answer and the tools each offers. An agent that names a server
you have since deleted carries on without it, and its runs say so. A server
can carry hooks, for example
a memory lookup injected before each turn. The todo is the hooks' session:
`sessionStart` fires on its first run, `beforeTurn`, `afterTurn` and
`sessionEnd` on every run, and `sessionDelete` after the todo is deleted for
good, so a memory server can forget what it filed. The delete does not wait
for that: the runner tells the servers afterwards, tries a few times, and
gives up with a line in the server's log. `beforeCompact` never fires, since a
run does not compact its transcript, and a run says so when a hook is bound to
it.

Before a request is a todo you can **talk it over** with an agent: it asks what
it needs to and writes the title and brief as you go. Each of its replies is a
run like a station's, with the agent, the model, what it was told, what it said
and what it spent, so a reply that failed can be opened and read. They are
listed in the draft and among the project's runs, marked as drafts, and counted
in its spend; a todo made from a draft shows them at the top of its history. A
reply's token counts are estimated from the text, and the run says so.
Discarding a draft deletes its runs with it.

The runner is part of the server: it starts with it and signs itself in, so
there is nothing to set up. Until AI is on it only checks, every few seconds,
whether there is anything to do.

Getting a first run takes a few steps in a few places, so the app keeps a
**setup checklist** until they are all taken: the two switches, an agent, a
station, the project's switch, a first request, something that lets work start
(auto-run, or Run now), and the runner having asked for work in the last
minute. It shows on the home page, on a project with no station, and on the
project it points at. Each row is read from what is there now and links to
where it is fixed, and the list goes away when every row is ticked. An account
with AI off gets one line offering it on the home page, and with
`AI_ENABLED=false` there is nothing.

A card on the board says at a glance what you would otherwise open it to find:
how many notes you or an outside client left on it, **Sent back** when a
reviewer rejected the work and **Run failed** when the run never finished (the
reason is one press away on either), and how many attempts the station has
used of its limit. The marks update as the board does. The note count is there
with AI off too.

**Activity**, beside Stations in the sidebar, is the same thing across every
project you own. At the top is what needs you: each todo that is out of
attempts or whose last run errored, with its project, the reason, and a way to
send it round again. Under it is what the last 30 days cost in tokens, by
project and by agent; when your run retention is shorter than that, it says
which day the figures start on. Then three lists, newest first: runs (a
draft's replies among them, marked), artifacts with the todo and project each
came from, and archived todos with restore. A run opens as it does in its
project. The page is not there while AI is off.

A note you wrote can be edited or deleted from the todo's thread, and an edited
note says so, with the time. What a run reported, and a verdict it returned,
stay as written: the next agent may already have been told them. An edit
reaches the runs that start after it and no run already under way.

```bash
export AUTH_SECRET=$(openssl rand -hex 32)
docker compose up --build
# then, signed in as the admin: Settings → AI → switch on the instance, then your account
```

Agents talk to any OpenAI-compatible endpoint, so a local Ollama works. An
agent's base URL and the account's MCP servers are fetched from the server's host, so on
a shared instance keep it where it cannot reach anything private, and leave
`RUNNER_ALLOW_STDIO` off.

## Keeping a copy in step

`changes(since:)` on `/graphql` (and the `changes` tool on `/mcp`) hands back
what changed in your projects, todos and dependencies since a cursor: the rows
as they stand now, tombstones for what went, and the cursor to ask with next.
Leave `since` out to start from everything. An archived todo comes as an
update with `archivedAt` set; one deleted for good, or a project with
everything in it, comes as tombstones. Pages hold up to 200 entries by default
and 1000 at most; `hasMore` says to ask again straight away. A cursor is good
for 29 days and tombstones are kept for 30, so a client that is away longer
gets `CURSOR_EXPIRED` and starts again. An API key reads it too, and sees only
what AI may: when a todo or project leaves its view (ignored, or the project's
AI switched off) it gets a tombstone, and the row again if it comes back.

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
