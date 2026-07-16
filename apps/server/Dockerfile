# syntax=docker/dockerfile:1.7
#
# Build from the monorepo root:
#   docker build -f apps/server/Dockerfile -t syncflow-backend .
# (docker-compose.prod.yml does this for you)

# ---------------------------------------------------------------------------
# Stage 1: builder
#
# Installs the full workspace (needed so pnpm's frozen-lockfile check sees every
# workspace member — apps/web and tests/e2e included, even though this image never
# ships them), builds the two workspace packages the server depends on plus the
# server itself, then uses `pnpm deploy --prod` to assemble a self-contained,
# dev-deps-pruned production tree (verified: it correctly inlines packages/crdt and
# packages/schemas' built dist/ output and drops devDependencies like typescript,
# vitest, tsx).
# ---------------------------------------------------------------------------
FROM node:20-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.9 --activate

WORKDIR /workspace

# Manifests only, first — maximizes layer cache reuse across builds that don't
# touch dependencies.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/crdt/package.json packages/crdt/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY tests/e2e/package.json tests/e2e/package.json

RUN pnpm install --frozen-lockfile

COPY packages/crdt packages/crdt
COPY packages/schemas packages/schemas
COPY apps/server apps/server

RUN pnpm --filter @sync-flow/crdt build \
 && pnpm --filter @sync-flow/schemas build \
 && pnpm --filter server build

RUN pnpm --filter server deploy --prod /prod/server

# ---------------------------------------------------------------------------
# Stage 2: production runtime
#
# Minimal image: no pnpm, no source, no devDependencies. dumb-init reaps zombies
# and forwards signals correctly to PID 1; the app runs as a non-root user.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS prod

RUN apk add --no-cache dumb-init curl \
 && addgroup -g 1001 -S syncflow \
 && adduser -S -u 1001 -G syncflow syncflow

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder --chown=syncflow:syncflow /prod/server/dist ./dist
COPY --from=builder --chown=syncflow:syncflow /prod/server/node_modules ./node_modules
COPY --from=builder --chown=syncflow:syncflow /prod/server/package.json ./package.json
COPY --from=builder --chown=syncflow:syncflow /prod/server/migrations ./migrations
COPY --chown=syncflow:syncflow apps/server/docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

USER syncflow
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:4000/health || exit 1

ENTRYPOINT ["dumb-init", "--", "/app/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
