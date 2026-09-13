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
      JWT_SECRET: ${JWT_SECRET:?generate one with `openssl rand -hex 32`}
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
printf 'JWT_SECRET=%s\nPOSTGRES_PASSWORD=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 24)" > .env

docker compose up -d
```

Telos is on <http://localhost:3001>. Migrations run at boot, so there is no
setup step. Sign in with any email address — Telos ships no mail provider, so
the magic link goes to the log, and that is the delivery channel:

```bash
docker compose logs -f telos
```

Keep that `.env`. `JWT_SECRET` signs sessions, so changing it signs everyone
out, and `POSTGRES_PASSWORD` is the database's own. Your data lives in the
`telos_pgdata` volume, which survives `docker compose down`; upgrade with
`docker compose pull && docker compose up -d`.

Read [**Before you expose it**](#before-you-expose-it) before putting this on a
domain.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | **Required.** Postgres connection string. There is no embedded fallback. |
| `JWT_SECRET` | — | **Required in production.** Signs session and magic-link tokens. `openssl rand -hex 32`. |
| `APP_URL` | `http://localhost:3001` | Public URL; magic-link URLs are built from it. |
| `PORT` | `3001` | Port the server listens on. |
| `AUTH_MAGIC_LINK` | `true` | Set to `false` to sign in with an address alone, no link. |
| `EXPOSE_MAGIC_LINK` | dev only | Return the magic link in the API response so the login page can show it. |

Telos ships no mail provider. With magic links on, the link is written to the
server log, and that is the delivery channel — pipe the log somewhere you can
read, or run with `AUTH_MAGIC_LINK=false`.

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
- **Set a real `JWT_SECRET`** and keep it. Changing it signs everyone out; leaking
  it lets anyone mint a session. The server refuses to boot in production while
  it is unset or still the default.

## Development

```bash
git clone https://github.com/cubicecho/telos.git
cd telos

cp .env.example .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env

npm install
npm run db:up          # Postgres on 127.0.0.1:5435
npm run db:migrate
npm run codegen
npm run dev            # API on 3001, Expo dev server on 3000
```

`npm run check` runs codegen, Biome and `tsc --noEmit` across all three
workspaces; `npm test` runs the suite against an in-memory Postgres. See
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
export JWT_SECRET=$(openssl rand -hex 32)
docker compose up --build
```

## License

[MIT](LICENSE) © Benjamin Van Treese
