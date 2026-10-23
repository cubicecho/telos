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
- **Sign-in by emailed link**, through an OpenID Connect provider such as
  heautou, or with an address alone on a private network. Never a password.

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
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?generate one with `openssl rand -hex 32`}
      DATABASE_URL: postgres://telos:${POSTGRES_PASSWORD:?set a database password}@postgres:5432/telos
      # The address you actually reach Telos at. Sign-in links are built from
      # it, so a link to localhost is useless in an inbox.
      APP_URL: ${APP_URL:-http://localhost:3001}
      # How sign-in links are emailed: a nodemailer URL. See "Signing in" below.
      SMTP_URL: ${SMTP_URL:-}
      # Or, on a network nothing hostile can reach, an address alone signs in.
      SECURE_LOCAL_NET: ${SECURE_LOCAL_NET:-false}
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
printf 'BETTER_AUTH_SECRET=%s\nPOSTGRES_PASSWORD=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > .env
```

Then give it a way to sign people in, one of:

- **Email**: add `SMTP_URL=smtp://user:pass@mail.example.com:587` to `.env`,
  and links are emailed.
- **An OpenID Connect provider** such as heautou: nothing to add now. The login
  page of a new instance has a **Set up sign-in** tab to paste the provider's
  setup URL into ([below](#signing-in-with-an-oidc-provider)).
- **Just trying it on this machine**: add `SECURE_LOCAL_NET=true`, and typing an
  address signs you in. Never on a reachable instance.

```bash
docker compose up -d
```

Telos is on <http://localhost:3001>. Migrations run at boot, so there is no
setup step. The first account to sign in runs the instance.

Keep that `.env`. `BETTER_AUTH_SECRET` is what sessions are signed with, and
`POSTGRES_PASSWORD` is the database's own. Your data lives in the
`telos_pgdata` volume, which survives `docker compose down`; upgrade with
`docker compose pull && docker compose up -d`.

Read [**Before you expose it**](#before-you-expose-it) before putting this on a
domain.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | **Required.** Postgres connection string. There is no embedded fallback. |
| `BETTER_AUTH_SECRET` | — | **Required in production.** Signs sessions. At least 32 characters: `openssl rand -hex 32`. |
| `APP_URL` | `http://localhost:3001` | Public URL; sign-in links and each todo's and project's `url` (`/todos/<id>`, `/projects/<id>`, for other apps to link back) are built from it. |
| `SERVER_URL` | `APP_URL` in production | Where a browser reaches the server, for the OIDC sign-in's start and callback. Only differs from `APP_URL` in development, where the app has a port of its own. |
| `PORT` | `3001` | Port the server listens on. |
| `SMTP_URL` | — | How sign-in links are emailed: a nodemailer connection URL. Unset, no links are sent. |
| `SMTP_FROM` | `telos@<APP_URL's host>` | The address sign-in email comes from. |
| `SECURE_LOCAL_NET` | `false` | Typing an address signs in, with no link. Private networks only: the server refuses it when `APP_URL` is a public host, unless `I_KNOW_SECURE_LOCAL_NET_IS_PUBLIC=true`. |
| `TRUST_PROXY` | `false` | How many reverse proxies sit in front (`1` behind one), or Express's `trust proxy` value. Sign-in is throttled per client address, which is only right when this is. |
| `OIDC_ISSUER` | — | Sets the OpenID Connect provider, with `OIDC_CLIENT_ID`, instead of pairing one from the app (below). The issuer URL; for heautou it ends in `/oidc`. |
| `OIDC_CLIENT_ID` | — | The client ID registered with the provider. |
| `OIDC_CLIENT_SECRET` | — | The client's secret. Leave it unset for a public client. |
| `OIDC_CLIENT_AUTH` | `client_secret_basic` | How the secret is sent: `client_secret_basic` (heautou's default) or `client_secret_post`. |
| `OIDC_NAME` | `SSO` | The provider's name on the login button ("Sign in with …"). |
| `OIDC_API_AUDIENCE` | `<SERVER_URL>/graphql` | Telos's API identifier at the provider: the `aud` a provider access token must carry to be accepted as a bearer. |
| `OIDC_DEVICE_CLIENT_ID` | — | The public client device apps (Home Assistant) use at the provider for the device flow. Telos only tells them its name, in `authConfig.sso.deviceClientId`. Pairing registers one for you; set this to use another. |
| `AI_ENABLED` | — | Set to `false` to remove AI entirely: no MCP endpoint, no API keys, no agents, no switch in Settings. Otherwise an admin turns it on in Settings. |
| `RUNNER_POLL_SECONDS` | `5` | How long the runner waits when nothing is ready. |
| `RUNNER_KEY` | made up at boot | Only for a second runner on another host (`runner/`, with `TELOS_URL`): set the same value on both. |

### Signing in

Telos has no passwords. A person signs in with a link emailed through
`SMTP_URL`, through an OpenID Connect provider, or, with `SECURE_LOCAL_NET`, by
typing their address. The login page shows only what the instance offers, and
the server warns at boot when it offers nothing. Sign-in is throttled, per
address and per client address: five tries in a quarter hour.

Upgrading from 5.x: `AUTH_SECRET` (or `JWT_SECRET`) is now `BETTER_AUTH_SECRET`,
`AUTH_MAGIC_LINK=false` is now `SECURE_LOCAL_NET=true`, and links are no longer
written to the log or returned by `EXPOSE_MAGIC_LINK`: set `SMTP_URL`, or pair
a provider. The server refuses to start while an old name is set, and says
which to use instead.

### Signing in with an OIDC provider

Telos can sign people in through any OpenID Connect provider, next to magic
links. With heautou, or any provider that supports Dynamic Client Registration,
pairing is one paste:

1. In heautou, make a setup URL for Telos and choose which groups may sign in.
   It looks like `https://<heautou>/oidc#setup=<token>&name=heautou`, and works
   for a short while.
2. On a new instance, open the login page's **Set up sign-in** tab and paste it.
   Once anyone has an account, an admin does this in **Settings → Sign-in**.
3. The login page shows "Sign in with heautou" at once, with no restart. On a
   new instance, the first account to sign in becomes the admin.
4. Back in heautou, the pairing dialog offers **Device sign-in** (a client
   Telos registered for Home Assistant and other device apps) and **Telos's
   API** (`<SERVER_URL>/graphql`, found in Telos's
   `/.well-known/oauth-protected-resource`). Leave both on and choose
   **Finish**, and device apps can sign in with no further setup.

Telos registers itself with the provider and keeps the client it gets back in
the database. **Disconnect** in Settings deletes that client at the provider
and takes the button away.

For a provider without registration, or to pin the provider in configuration,
use the environment instead, which wins over a pairing and cannot be changed
from the app:

1. Register a client whose redirect URI is exactly
   `<SERVER_URL>/api/auth/callback/oidc` (which is `<APP_URL>/…` in
   production). The server prints it at boot.
2. Set `OIDC_ISSUER=https://<provider>/oidc`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET` and, for the button, `OIDC_NAME`.
3. Restart.

Someone signing in this way gets the account with the email address the
provider vouches for, or a new one if there is none. Setting only one of
`OIDC_ISSUER` and `OIDC_CLIENT_ID` stops the server at boot.

### Apps that sign in without a browser (Home Assistant)

A device app signs in at the provider instead, with the OAuth device flow, and
calls the API with the provider's access token as `Authorization: Bearer`.
Telos accepts it as the person, exactly as a session, live boards included,
when:

- it is a JWT access token (`typ: at+jwt`, RFC 9068) from the provider in
  effect, signed with a key in its JWKS by an asymmetric algorithm;
- its `aud` includes `OIDC_API_AUDIENCE` (default `<SERVER_URL>/graphql`), so
  register that audience as an API (resource) at the provider; and
- its `sub` is someone who has signed in to Telos through the provider in a
  browser at least once. Tokens are never matched to an account by email.

A live board opened with such a token ends, with `UNAUTHENTICATED`, when the
token expires, and the app reconnects with a fresh one. A client can find the
provider and the audience at `GET /.well-known/oauth-protected-resource`
(RFC 9728), and a refused bearer is answered with a `WWW-Authenticate`
challenge pointing there. After pairing with heautou, finishing the pairing
there sets up both the device client and the API. Telos registers the device
client with the same setup URL whenever the provider offers the device flow,
and tells device apps about it only once the provider has turned it on (it
checks the registration at most once a minute). `OIDC_DEVICE_CLIENT_ID` names
another client instead; with another provider, or with `OIDC_ISSUER`, register
the device client and the API there by hand.

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
   **Agents** (the agent defaults and the agents) and
   **MCP servers**.
3. **The project**: its AI switch, in **Edit project**. Off, the project takes no requests and its
   lanes' agents sit idle.
   Under it is a second switch, **auto-run**: whether the project's agents
   start on todos by themselves. It is off on a new project, so switching AI on
   starts nothing. Off, an agent works a todo only when you ask: **Run now**,
   on its card or in its Runs tab, has the agent of the lane it stands in work
   it once. It then follows the lane's route and waits again. Switching auto-run off
   lets what is running finish.
4. **The todo**: "AI ignores this". The runner leaves it alone.

With AI on there are two doors in. **`/mcp`** is for your own agents (Claude
Code and the like): with an API key from Settings they can read the board and
what happened on it (lanes, runs and their logs, history, notes, blockers,
spend, artifacts, templates, and the agents without their keys), and
work it: make and rename projects, add, edit, move, retry, run, stop, archive,
restore and delete todos, set what they wait on, write notes, record what they made for a todo (`record_artifact`: where it is
and what to call it), and save or apply a board template. Each key has a switch
per tool in Settings, all on until you turn one off; a tool that is off is
neither offered to the key nor allowed to it, so a read-only key is one with
its writing tools off. The AI switches, agents, keys, lanes and their agents, bulk
changes and deleting a project stay yours. Nothing checks what a client
records, so the board lists it as unverified, signed with the key that said it. **The runner** is telos's own
worker. Three ideas make it up:

- an **agent** is a model and the prompt it works from;
- a **lane** is a column; give it an agent (its menu, **Agent…**) and each
  ready todo there becomes a run, which on success or failure follows the
  lane's success or failure route;
- a **run** ends in success or failure, with a report and, if the agent chose,
  new todos.

What an agent does is in its prompt, and every reply is read the same
way: one that opens with FAIL sends the todo along the failure route, anything
else passes (open with PASS to say so). A passing run can split its todo into
new ones, which land in the lane the project sends new todos to (set in the
project's form; the first open lane otherwise), and the todo is done when they
all are.
An agent picks its prompt from your **Prompts** (Settings → Prompts). Every
account starts with three: a **Planner** that makes a todo ready by rewriting or
splitting it, a **Reviewer** that rules PASS or FAIL, and a **Worker** that does
the work and reports. Edit them, delete them or add your own. Every run is told,
in this order: your **agent instructions** (Settings; a short default that
**Reset** goes back to), the project's description, the project's prompt, then
the agent's prompt. All four are yours to write; AI clients can't change them.
Give an agent a base URL and a model, or leave those to your agent defaults. An agent's form, like the
defaults', starts at its endpoint: type the base URL (and a key, if it wants
one) and its models are listed, to pick from, with the context length each
reports; an endpoint that lists nothing still takes a model typed by name.
A reasoning effort (off, or a level from none to max) is sent as
`reasoning_effort` to a model that deliberates; an agent can turn off a level its
defaults ask for. A lane's success route can archive
what passes instead of moving it: the todo is completed and leaves the board,
for a pipeline whose finished work nobody needs to see in a column. The runner claims by itself in a project with auto-run on,
and only the todos you asked for in one with it off. Each run keeps a log of its tool calls, which the
todo shows as it goes, and a list of what it made: files it wrote, and anything
the agent chose to record. What was made for a todo outlives it: delete the
todo for good and its artifacts stay on the project's Artifacts list, under the
title the todo had, until you remove them or delete the project. **MCP
servers** are kept once, under Settings → MCP servers, and each agent reaches every one
of them or only the ones you tick. Every server is a URL (streamable HTTP):
telos does not run stdio servers, so a pasted `.mcp.json` lists any command
entries as not supported. A server's headers are secrets: you can see which are set, never their values, and only the runner is
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

The runner is part of the server: it starts with it and signs itself in, so
there is nothing to set up. Until AI is on it only checks, every few seconds,
whether there is anything to do.

Getting a first run takes a few steps in a few places, so the app keeps a
**setup checklist** until they are all taken: the two switches, an agent, a
lane with an agent, the project's switch, a first request, something that lets work start
(auto-run, or Run now), and the runner having asked for work in the last
minute. It shows on the home page, on a project with no lane with an agent, and on the
project it points at. Each row is read from what is there now and links to
where it is fixed, and the list goes away when every row is ticked. An account
with AI off gets one line offering it on the home page, and with
`AI_ENABLED=false` there is nothing.

A card on the board says at a glance what you would otherwise open it to find:
how many notes you or an outside client left on it, **Sent back** when a
reviewer rejected the work and **Run failed** when the run never finished (the
reason is one press away on either), and how many attempts the lane's agent has
used of its limit. The marks update as the board does. The note count is there
with AI off too.

**Activity**, beside Agents in the sidebar, is the same thing across every
project you own. At the top is what needs you: each todo that is out of
attempts or whose last run errored, with its project, the reason, and a way to
send it round again. Under it is what the last 30 days cost in tokens, by
project and by agent; when your run retention is shorter than that, it says
which day the figures start on. Then three lists, newest first: runs,
artifacts with the todo and project each
came from, and archived todos with restore. A run opens as it does in its
project. The page is not there while AI is off.

A note you wrote can be edited or deleted from the todo's thread, and an edited
note says so, with the time. What a run reported, and a verdict it returned,
stay as written: the next agent may already have been told them. An edit
reaches the runs that start after it and no run already under way.

```bash
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)
docker compose up --build
# then, signed in as the admin: Settings → AI → switch on the instance, then your account
```

Agents talk to any OpenAI-compatible endpoint, so a local Ollama works. An
agent's base URL and the account's MCP servers are fetched from the server's host, so on
a shared instance keep it where it cannot reach anything private. The runner
runs no commands on its host: every MCP server is a URL.

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
  yours alone — an allowlist, VPN, or auth in front of it. Telos throttles
  sign-in per address and per client address, in process. Behind a proxy, set
  `TRUST_PROXY` to say so, or every visitor shares the proxy's budget.
- **Never set `SECURE_LOCAL_NET` on a reachable instance.** It makes an email
  address the entire credential: anyone who can load the login page can sign in
  as anyone. The server refuses it when `APP_URL` names a public host.
- **Set a real `BETTER_AUTH_SECRET`** and keep it. Leaking it lets anyone forge a
  session. The server refuses to boot in production while it is unset, shorter
  than 32 characters, or a published default.

## Development

```bash
git clone https://github.com/cubicecho/telos.git
cd telos

cp .env.example .env
sed -i "s/^BETTER_AUTH_SECRET=.*/BETTER_AUTH_SECRET=$(openssl rand -hex 32)/" .env
# No mail server in development: an address alone signs in, on localhost only.
echo 'SECURE_LOCAL_NET=true' >> .env

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
export BETTER_AUTH_SECRET=$(openssl rand -hex 32)
docker compose up --build
```

## License

[MIT](LICENSE) © Benjamin Van Treese
