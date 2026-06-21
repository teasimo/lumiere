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

aws_cli_args() {
  local -a args
  args=()

  if [[ -n "${S3_ENDPOINT_URL:-}" ]]; then
    args+=("--endpoint-url" "${S3_ENDPOINT_URL}")
  fi

  printf '%s\n' "${args[@]}"
}

sync_dir_from_s3() {
  local remote_path="$1"
  local local_path="$2"
  local -a extra_args

  mkdir -p "${local_path}"
  mapfile -t extra_args < <(aws_cli_args)
  aws "${extra_args[@]}" s3 sync "${remote_path}" "${local_path}" --only-show-errors
}

sync_dir_to_s3() {
  local local_path="$1"
  local remote_path="$2"
  local -a extra_args

  mkdir -p "${local_path}"
  mapfile -t extra_args < <(aws_cli_args)
  aws "${extra_args[@]}" s3 sync "${local_path}" "${remote_path}" --delete --only-show-errors
}

restore_runtime_data_from_s3() {
  if [[ -z "${S3_BUCKET:-}" ]]; then
    return
  fi

  local data_root s3_prefix bucket_url
  data_root="${WORKER_DATA_ROOT:-/app/runtime-data}"
  s3_prefix="${S3_PREFIX:-lumiere-worker}"
  bucket_url="s3://${S3_BUCKET}/${s3_prefix}"

  echo "[azure-watcher-worker] Restore aus ${bucket_url}"
  sync_dir_from_s3 "${bucket_url}/output" "${data_root}/output"
  sync_dir_from_s3 "${bucket_url}/temp" "${data_root}/temp"
  sync_dir_from_s3 "${bucket_url}/watcher-cache" "${data_root}/watcher-cache"
}

flush_runtime_data_to_s3() {
  if [[ -z "${S3_BUCKET:-}" ]]; then
    return
  fi

  local data_root s3_prefix bucket_url
  data_root="${WORKER_DATA_ROOT:-/app/runtime-data}"
  s3_prefix="${S3_PREFIX:-lumiere-worker}"
  bucket_url="s3://${S3_BUCKET}/${s3_prefix}"

  echo "[azure-watcher-worker] Sync nach ${bucket_url}"
  sync_dir_to_s3 "${data_root}/output" "${bucket_url}/output"
  sync_dir_to_s3 "${data_root}/temp" "${bucket_url}/temp"
  sync_dir_to_s3 "${data_root}/watcher-cache" "${bucket_url}/watcher-cache"
}

start_s3_sync_loop() {
  if [[ -z "${S3_BUCKET:-}" ]]; then
    return
  fi

  local interval
  interval="${S3_SYNC_INTERVAL_SECONDS:-60}"

  (
    while true; do
      sleep "${interval}"
      flush_runtime_data_to_s3 || echo "[azure-watcher-worker] Warnung: periodischer S3-Sync fehlgeschlagen"
    done
  ) &

  export S3_SYNC_LOOP_PID="$!"
}

stop_s3_sync_loop() {
  if [[ -n "${S3_SYNC_LOOP_PID:-}" ]]; then
    kill "${S3_SYNC_LOOP_PID}" >/dev/null 2>&1 || true
    wait "${S3_SYNC_LOOP_PID}" >/dev/null 2>&1 || true
  fi
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
  stop_s3_sync_loop
  flush_runtime_data_to_s3 || echo "[azure-watcher-worker] Warnung: finaler S3-Sync fehlgeschlagen"
}

trap shutdown EXIT INT TERM

hydrate_google_credentials
link_runtime_data
restore_runtime_data_from_s3
node /app/deploy/azure-watcher-worker/prepare-runtime-config.mjs
start_s3_sync_loop

mapfile -t watcher_args < <(build_watcher_args)

node /app/scripts/lunettes-job-watcher/watch-lunettes-jobs.mjs "${watcher_args[@]}" &
WATCHER_PID="$!"

wait "${WATCHER_PID}"
WATCHER_EXIT_CODE="$?"
WATCHER_PID=""

exit "${WATCHER_EXIT_CODE}"
