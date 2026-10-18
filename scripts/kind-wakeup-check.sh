#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" == "Darwin" && "${EVALFLOW_WAKEUP_AWAKE:-}" != 1 ]]; then
    exec caffeinate -i env EVALFLOW_WAKEUP_AWAKE=1 bash "$0" "$@"
fi
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
pnpm typecheck
pnpm test:benchmark
# Same fresh backend image and committed migration for all three conditions.
bash scripts/kind-app-up.sh --autoscaling
bash scripts/kind-benchmark.sh --verify-wakeup
