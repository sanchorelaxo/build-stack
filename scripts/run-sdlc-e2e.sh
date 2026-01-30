#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

COMPOSE_BIN="${COMPOSE_BIN:-docker-compose}"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"

# Load environment variables from .env file
if [[ -f "${ENV_FILE}" ]]; then
  set -a
  source "${ENV_FILE}"
  set +a
fi

require_port_free() {
  local port="$1"

  if command -v ss >/dev/null 2>&1; then
    if ss -ltnH "sport = :${port}" | grep -q .; then
      echo "Port ${port} is already in use; free it before running the E2E." >&2
      ss -ltnp "sport = :${port}" || true
      exit 1
    fi
  elif command -v lsof >/dev/null 2>&1; then
    if lsof -iTCP:"${port}" -sTCP:LISTEN -nP >/dev/null 2>&1; then
      echo "Port ${port} is already in use; free it before running the E2E." >&2
      lsof -iTCP:"${port}" -sTCP:LISTEN -nP || true
      exit 1
    fi
  fi
}

check_vm_max_map_count() {
  if [[ -r /proc/sys/vm/max_map_count ]]; then
    local current
    current="$(cat /proc/sys/vm/max_map_count)"
    if [[ "${current}" -lt 262144 ]]; then
      echo "vm.max_map_count is ${current} but SonarQube requires at least 262144." >&2
      echo "Set it temporarily with: sudo sysctl -w vm.max_map_count=262144" >&2
      echo "Or permanently via /etc/sysctl.conf (or a file in /etc/sysctl.d/)." >&2
      exit 1
    fi
  fi
}

echo "==> Cleaning up any existing stack (down --remove-orphans)"
"${COMPOSE_BIN}" -f "${ROOT_DIR}/docker-compose.yml" down --remove-orphans || true

echo "==> Preflight: checking required host ports"
check_vm_max_map_count
require_port_free 3000
require_port_free 222
require_port_free 8080
require_port_free 8081
require_port_free 9000
require_port_free 8088
require_port_free 8090

echo "==> Bringing stack up"
"${COMPOSE_BIN}" -f "${ROOT_DIR}/docker-compose.yml" up -d --build

echo "==> Installing e2e deps"
( cd "${ROOT_DIR}/e2e" && npm install )

echo "==> Installing Playwright browsers (first run may be slow)"
( cd "${ROOT_DIR}/e2e" && npx playwright install --with-deps )

echo "==> Running e2e"
( cd "${ROOT_DIR}/e2e" && npx playwright test )
