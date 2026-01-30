#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-${ROOT_DIR}/docker-compose.yml}"

COMPOSE_CMD=()

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not installed or not on PATH" >&2
  exit 127
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "Neither 'docker compose' (plugin) nor 'docker-compose' is available." >&2
  exit 127
fi

echo "==> Validating compose file: ${COMPOSE_FILE}"
"${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" config >/dev/null

if [[ "${PULL:-1}" == "1" ]]; then
  echo "==> Pulling images"
  "${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" pull
fi

echo "==> Rendered services:"
"${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" config --services

if [[ "${SMOKE:-0}" == "1" ]]; then
  echo "==> Starting (smoke test)"
  "${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" up -d

  echo "==> Status"
  "${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" ps

  echo "==> Stopping (smoke test)"
  "${COMPOSE_CMD[@]}" -f "${COMPOSE_FILE}" down --remove-orphans
fi

echo "OK"
