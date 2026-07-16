# SyncFlow

[![CI](https://github.com/mubeendevelops/sync-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/mubeendevelops/sync-flow/actions/workflows/ci.yml)
[![Deploy](https://github.com/mubeendevelops/sync-flow/actions/workflows/deploy.yml/badge.svg)](https://github.com/mubeendevelops/sync-flow/actions/workflows/deploy.yml)
[![codecov](https://codecov.io/gh/mubeendevelops/sync-flow/branch/main/graph/badge.svg)](https://codecov.io/gh/mubeendevelops/sync-flow)

Real-time collaborative document editor with a hand-rolled RGA CRDT. See `CLAUDE.md` for the
full architecture and `PLAN.md` for the build plan (both local-only, not committed to git).

This repo currently has **local infrastructure only** — no application code yet (that starts at
`PLAN.md` task 0.1).

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) with Compose v2 (`docker compose version`)
- [nvm](https://github.com/nvm-sh/nvm) (Node version is pinned in `.nvmrc`, currently Node 22)

## Getting Started

```bash
# 1. Clone and enter the repo
cd sync-flow

# 2. Use the pinned Node version
nvm install
nvm use

# 3. Create your local env file
cp .env.example .env

# 4. Start Postgres + Redis
make up

# 5. Check both containers report healthy
docker compose ps
```

Postgres is reachable at `localhost:5434` and Redis at `localhost:6380` — both remapped from
their defaults (5432 / 6379) to avoid colliding with other services already running on this
machine. Credentials and connection strings are in `.env` (copied from `.env.example`).

## Makefile commands

| Command          | Description                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `make up`        | Start Postgres + Redis in the background                            |
| `make down`      | Stop the containers (data persists in named volumes)                |
| `make logs`      | Tail logs from both containers                                      |
| `make psql`      | Open a `psql` shell inside the Postgres container                   |
| `make redis-cli` | Open a `redis-cli` shell inside the Redis container                 |
| `make reset`     | **Destroys** both volumes and recreates the containers from scratch |

## Verifying it works

```bash
make psql
# inside psql:
\conninfo
\q

make redis-cli
# inside redis-cli:
ping   # should reply PONG
exit
```

## Next steps

Application code (pnpm monorepo, `packages/crdt`, `apps/server`, `apps/web`) starts at
Phase 0 in `PLAN.md`.
