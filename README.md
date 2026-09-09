# Telos

A self-hostable todo app that is *just* todos.

Projects hold todos. Todos can depend on other todos, and a todo you are waiting
on is one you cannot tick off yet — Telos knows that and says so. Labels attach
to projects and todos alike. That is the whole product.

- **Projects** — a sidebar of them, each with open and total counts.
- **Todos** — a title, a checkbox, a delete button. Add one in a sentence and Enter.
- **Dependencies** — a blocked todo sits in its own section with its blockers
  named and its checkbox disabled. Cycles are rejected when you try to create them.
- **Labels** — one colour, one name, attachable to anything.
- **Sign-in by magic link**, or no link at all on a private instance.

## Self-hosting

One container plus Postgres. The app and the API are served from the same
origin, so there is no second host to configure.

```bash
git clone https://github.com/cubicecho/telos.git
cd telos

# The one secret you must set. Compose refuses to start without it.
export JWT_SECRET=$(openssl rand -hex 32)

docker compose up --build
```

Telos is now on <http://localhost:3002>. Migrations run at boot, so there is no
setup step. Sign in with any email address: the magic link is printed to the
server log.

```bash
docker compose logs -f telos
```

Data lives in the `telos_pgdata` volume. Postgres is published on
`127.0.0.1:5435` for your own tooling and is not reachable from the network.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | — | **Required.** Postgres connection string. There is no embedded fallback. |
| `JWT_SECRET` | — | **Required in production.** Signs session and magic-link tokens. `openssl rand -hex 32`. |
| `APP_URL` | `http://localhost:3002` | Public URL; magic-link URLs are built from it. |
| `PORT` | `3002` | Port the server listens on. |
| `AUTH_MAGIC_LINK` | `true` | Set to `false` to sign in with an address alone, no link. |
| `EXPOSE_MAGIC_LINK` | dev only | Return the magic link in the API response so the login page can show it. |

Telos ships no mail provider. With magic links on, the link is written to the
server log, and that is the delivery channel — pipe the log somewhere you can
read, or run with `AUTH_MAGIC_LINK=false`.

### Before you expose it

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
cp .env.example .env
sed -i "s/^JWT_SECRET=.*/JWT_SECRET=$(openssl rand -hex 32)/" .env

npm install
npm run db:up          # Postgres on 127.0.0.1:5435
npm run db:migrate
npm run codegen
npm run dev            # API on 3002, Expo dev server on 3004
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
