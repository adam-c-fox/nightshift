#!/usr/bin/env bash
set -euo pipefail

NAME=nightshift-example-test-pg
URL=postgresql://nightshift:nightshift@127.0.0.1:55433/nightshift_test
TIMEOUT_SECONDS=60

running() { [ -n "$(docker ps -q -f "name=^${NAME}$")" ]; }
exists() { [ -n "$(docker ps -aq -f "name=^${NAME}$")" ]; }
ready() { docker exec "$NAME" pg_isready -h 127.0.0.1 -U nightshift -d nightshift_test >/dev/null 2>&1; }

up() {
  if ! running; then
    if exists; then docker rm -f "$NAME" >/dev/null; fi
    docker run -d --rm --name "$NAME" \
      -e POSTGRES_USER=nightshift -e POSTGRES_PASSWORD=nightshift -e POSTGRES_DB=nightshift_test \
      -p 127.0.0.1:55433:5432 postgres:15-alpine >/dev/null
  fi
  local waited=0
  until ready; do
    if [ "$waited" -ge "$TIMEOUT_SECONDS" ]; then
      echo "Postgres did not become ready within ${TIMEOUT_SECONDS}s" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "$URL"
}

down() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }

case "${1:-}" in
  up) up ;;
  down) down ;;
  url) echo "$URL" ;;
  *) echo "usage: $0 up|down|url" >&2; exit 2 ;;
esac
