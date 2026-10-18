#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" == "Darwin" && "${EVALFLOW_POLLING_AWAKE:-}" != 1 ]]; then
    exec caffeinate -i env EVALFLOW_POLLING_AWAKE=1 bash "$0" "$@"
fi
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
pnpm typecheck
pnpm test:benchmark
docker compose --profile test up -d postgres-test
pnpm test
# Deploy the worker claim-counter instrumentation using the normal Helm/image workflow.
bash scripts/kind-app-up.sh --autoscaling
bash scripts/kind-benchmark.sh --verify-polling
