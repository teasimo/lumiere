#!/usr/bin/env bash
set -euo pipefail

cd /app

hydrate_google_credentials() {
  if [[ -z "${GOOGLE_APPLICATION_CREDENTIALS_JSON:-}" ]]; then
    return
  fi

  local credentials_path
  credentials_path="${GOOGLE_APPLICATION_CREDENTIALS_PATH:-/tmp/google-application-credentials.json}"
  printf '%s' "${GOOGLE_APPLICATION_CREDENTIALS_JSON}" > "${credentials_path}"
  chmod 600 "${credentials_path}"
  export GOOGLE_APPLICATION_CREDENTIALS="${credentials_path}"
}

derive_worker_identity() {
  local base_worker_id revision effective_worker_id
  base_worker_id="${WATCHER_WORKER_ID:-}"
  revision="${CONTAINER_APP_REVISION:-}"

  if [[ -z "${revision}" ]]; then
    return
  fi

  if [[ -n "${base_worker_id}" ]]; then
    effective_worker_id="${base_worker_id}@${revision}"
  else
    effective_worker_id="${revision}"
  fi

  export WATCHER_WORKER_ID="${effective_worker_id}"
}

link_runtime_data() {
  if [[ "${PERSIST_RUNTIME_DATA:-1}" != "1" ]]; then
    return
  fi

  local data_root
  data_root="${WORKER_DATA_ROOT:-/app/runtime-data}"

  mkdir -p "${data_root}/output" "${data_root}/temp" "${data_root}/watcher-cache"
  mkdir -p /app/neo/interactions

  rm -rf /app/output /app/temp /app/neo/interactions/_lunettes-job-watcher
  ln -sfn "${data_root}/output" /app/output
  ln -sfn "${data_root}/temp" /app/temp
  ln -sfn "${data_root}/watcher-cache" /app/neo/interactions/_lunettes-job-watcher
}

build_watcher_args() {
  local -a args
  args=()

  if [[ "${WATCHER_ONCE:-0}" == "1" ]]; then
    args+=(--once)
  fi

  if [[ -n "${WATCHER_TYPES:-}" ]]; then
    args+=("--types=${WATCHER_TYPES}")
  fi

  if [[ -n "${WATCHER_SOFTWARE:-}" ]]; then
    args+=("--software=${WATCHER_SOFTWARE}")
  fi

  if [[ -n "${WATCHER_WORKER_ID:-}" ]]; then
    args+=("--worker-id=${WATCHER_WORKER_ID}")
  fi

  if [[ -n "${WATCHER_LEASE_SECONDS:-}" ]]; then
    args+=("--lease-seconds=${WATCHER_LEASE_SECONDS}")
  fi

  if [[ -n "${WATCHER_POLL_INTERVAL_MS:-}" ]]; then
    args+=("--poll-interval-ms=${WATCHER_POLL_INTERVAL_MS}")
  fi

  if [[ -n "${LUNETTES_BASE_URL:-}" ]]; then
    args+=("--base-url=${LUNETTES_BASE_URL}")
  elif [[ -n "${WATCHER_BASE_URL:-}" ]]; then
    args+=("--base-url=${WATCHER_BASE_URL}")
  fi

  printf '%s\n' "${args[@]}"
}

shutdown() {
  if [[ -n "${WATCHER_PID:-}" ]]; then
    kill "${WATCHER_PID}" >/dev/null 2>&1 || true
    wait "${WATCHER_PID}" >/dev/null 2>&1 || true
  fi
}

trap shutdown EXIT INT TERM

hydrate_google_credentials
derive_worker_identity
link_runtime_data
echo "[azure-watcher-worker] Watcher verwendet job-spezifischen Artefakt-Sync."
node /app/deploy/azure-watcher-worker/prepare-runtime-config.mjs

mapfile -t watcher_args < <(build_watcher_args)

node /app/scripts/lunettes-job-watcher/watch-lunettes-jobs.mjs "${watcher_args[@]}" &
WATCHER_PID="$!"

wait "${WATCHER_PID}"
WATCHER_EXIT_CODE="$?"
WATCHER_PID=""

exit "${WATCHER_EXIT_CODE}"
