#!/bin/sh
set -eu

# node-pg-migrate takes a non-blocking Postgres advisory lock (pg_try_advisory_lock)
# and throws immediately if it can't get it — see node_modules/node-pg-migrate/dist/
# runner.js. With `deploy.replicas: 2`, both backend containers run this entrypoint on
# startup and race for the lock; the loser's `migrate:up` exits non-zero right away, not
# because anything is actually wrong. Retry with a short backoff so the loser simply
# waits out the winner and then finds nothing left to migrate.
MAX_ATTEMPTS=10
ATTEMPT=1

until npm run migrate:up; do
  if [ "$ATTEMPT" -ge "$MAX_ATTEMPTS" ]; then
    echo "docker-entrypoint: migrations still failing after $MAX_ATTEMPTS attempts, giving up" >&2
    exit 1
  fi
  echo "docker-entrypoint: migrate:up failed (attempt $ATTEMPT/$MAX_ATTEMPTS) — likely lost the advisory-lock race to another replica, retrying in 3s" >&2
  ATTEMPT=$((ATTEMPT + 1))
  sleep 3
done

exec "$@"
