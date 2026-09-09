# syntax=docker/dockerfile:1

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:24-alpine AS builder

WORKDIR /app

COPY . .

# devDependencies included: codegen and the Expo web export both need them.
RUN npm ci

# The GraphQL schema is generated from the Drizzle schema, so codegen imports
# @telos/db — which refuses to load without a DATABASE_URL. postgres-js does not
# connect until a query runs, so a placeholder is enough to generate against.
ENV DATABASE_URL=postgres://build:build@127.0.0.1:5432/build
RUN npm run codegen && npm run build:app

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:24-alpine

WORKDIR /app

# Only the runtime workspaces are installed. Copying the built image wholesale
# would drag in Expo and Metro — hundreds of megabytes that exist to produce
# app/dist and are useless once it exists.
COPY package.json package-lock.json ./
COPY db/package.json db/
COPY server/package.json server/
COPY app/package.json app/
RUN npm ci --omit=dev --include-workspace-root --workspace @telos/db --workspace @telos/server \
 && npm cache clean --force

# The server is not compiled: it runs its TypeScript sources directly under
# --experimental-strip-types, so the sources are the build output.
COPY db/src db/src
COPY db/drizzle db/drizzle
COPY server/src server/src
COPY --from=builder /app/app/dist app/dist

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No --preserve-symlinks: it would resolve @telos/db to its path inside
# node_modules, and Node refuses to strip types from anything under there.
CMD ["node", "--experimental-strip-types", "server/src/index.ts"]
