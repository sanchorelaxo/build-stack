#!/usr/bin/env bash
set -euo pipefail

NEXUS_BASE_URL="${NEXUS_BASE_URL:-http://nexus:8081}"
NEXUS_REPO="${NEXUS_REPO:-web}"
NEXUS_PATH="${NEXUS_PATH:-hello-world/index.html}"
POLL_SECONDS="${POLL_SECONDS:-5}"
DEPLOY_FILE="${DEPLOY_FILE:-/deploy/index.html}"

ADMIN_PASSWORD_FILE="/nexus-data/admin.password"

wait_for_nexus() {
  echo "==> Waiting for Nexus at ${NEXUS_BASE_URL}"
  until curl -fsS "${NEXUS_BASE_URL}/service/rest/v1/status" >/dev/null 2>&1; do
    sleep 2
  done
}

get_admin_password() {
  if [[ ! -f "${ADMIN_PASSWORD_FILE}" ]]; then
    echo "Nexus admin password file not found at ${ADMIN_PASSWORD_FILE}" >&2
    exit 1
  fi
  tr -d '\n' < "${ADMIN_PASSWORD_FILE}"
}

ensure_raw_repo() {
  local admin_password="$1"

  if curl -fsS -u "admin:${admin_password}" "${NEXUS_BASE_URL}/service/rest/v1/repositories" | grep -q '"name"[[:space:]]*:[[:space:]]*"'"${NEXUS_REPO}"'"'; then
    echo "==> Nexus raw repo '${NEXUS_REPO}' already exists"
    return 0
  fi

  echo "==> Creating Nexus raw hosted repo '${NEXUS_REPO}'"
  curl -fsS -u "admin:${admin_password}" \
    -H 'Content-Type: application/json' \
    -X POST "${NEXUS_BASE_URL}/service/rest/v1/repositories/raw/hosted" \
    -d "{\"name\":\"${NEXUS_REPO}\",\"online\":true,\"storage\":{\"blobStoreName\":\"default\",\"strictContentTypeValidation\":false,\"writePolicy\":\"ALLOW\"},\"cleanup\":null,\"component\":{\"proprietaryComponents\":false}}" \
    >/dev/null
}

download_if_changed() {
  local admin_password="$1"
  local url="${NEXUS_BASE_URL}/repository/${NEXUS_REPO}/${NEXUS_PATH}"
  local etag_file
  etag_file="$(dirname "${DEPLOY_FILE}")/.etag"

  mkdir -p "$(dirname "${DEPLOY_FILE}")"

  local etag
  etag="$(curl -fsSI -u "admin:${admin_password}" "${url}" | awk -F': ' 'tolower($1)=="etag"{print $2}' | tr -d '\r' || true)"

  if [[ -n "${etag}" && -f "${etag_file}" ]]; then
    if [[ "$(cat "${etag_file}")" == "${etag}" ]]; then
      return 0
    fi
  fi

  if curl -fsS -u "admin:${admin_password}" -o "${DEPLOY_FILE}.tmp" "${url}"; then
    mv "${DEPLOY_FILE}.tmp" "${DEPLOY_FILE}"
    if [[ -n "${etag}" ]]; then
      echo -n "${etag}" > "${etag_file}"
    else
      rm -f "${etag_file}" || true
    fi
    echo "==> Updated ${DEPLOY_FILE} from ${url}"
  else
    rm -f "${DEPLOY_FILE}.tmp" || true
  fi
}

main() {
  wait_for_nexus
  local admin_password
  admin_password="$(get_admin_password)"

  ensure_raw_repo "${admin_password}"

  echo "==> Polling Nexus for ${NEXUS_REPO}/${NEXUS_PATH}"
  while true; do
    download_if_changed "${admin_password}" || true
    sleep "${POLL_SECONDS}"
  done
}

main "$@"
