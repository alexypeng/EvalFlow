#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?Set DATABASE_URL to the CI database}"
export LLM_PROVIDER=mock
export GEMINI_API_KEY=
export WORKER_CONCURRENCY=4
export POLL_INTERVAL_MS=100
export PORT="${PORT:-3000}"

report_dir="${EVALFLOW_REPORT_DIR:-.evalflow-ci}"
baseline_file="${EVALFLOW_BASELINE_FILE:-baselines/retention-v1.json}"
api_url="http://127.0.0.1:${PORT}"
api_pid=
worker_pid=
mkdir -p "$report_dir"
# Clear only this invocation's output, so an earlier report cannot represent a failed setup.
printf '' > "$report_dir/summary.md"

cleanup() {
    status=$?
    trap - EXIT
    if [[ ! -s "$report_dir/summary.md" ]]; then
        status=2
        printf '## EvalFlow regression check\n\n**Result: ERROR** (exit %s).\n\nSetup or evaluation failed. See the workflow logs and report artifact.\n' \
            "$status" > "$report_dir/summary.md"
    fi
    printf '%s\n' "$status" > "$report_dir/exit-code.txt"
    if [[ -n "$worker_pid" ]]; then kill "$worker_pid" 2>/dev/null || true; wait "$worker_pid" 2>/dev/null || true; fi
    if [[ -n "$api_pid" ]]; then kill "$api_pid" 2>/dev/null || true; wait "$api_pid" 2>/dev/null || true; fi
    exit "$status"
}
trap cleanup EXIT

test -f "$baseline_file"
pnpm --filter server build
pnpm --filter server exec prisma migrate deploy
node server/dist/loadDataset.js server/datasets/retention-v1.json

node server/dist/api.js > "$report_dir/api.log" 2>&1 &
api_pid=$!
ready=false
for attempt in {1..30}; do
    if ! kill -0 "$api_pid" 2>/dev/null; then break; fi
    if curl --fail --silent --max-time 2 "$api_url/health" > /dev/null; then ready=true; break; fi
    sleep 1
done
if [[ "$ready" != true ]]; then
    printf 'API did not become healthy\n' >&2
    exit 2
fi

node server/dist/worker.js > "$report_dir/worker.log" 2>&1 &
worker_pid=$!
node server/dist/cli.js run --dataset retention --dataset-version 1 --prompt v2 \
    --baseline "$baseline_file" --api-url "$api_url" --timeout-ms 120000 --format markdown \
    > "$report_dir/summary.md" 2> "$report_dir/gate.log"
