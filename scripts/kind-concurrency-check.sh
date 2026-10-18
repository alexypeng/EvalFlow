#!/usr/bin/env bash
set -euo pipefail
if [[ "$(uname -s)" == "Darwin" && "${EVALFLOW_CONCURRENCY_AWAKE:-}" != 1 ]]; then
    exec caffeinate -i env EVALFLOW_CONCURRENCY_AWAKE=1 bash "$0" "$@"
fi
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
pnpm typecheck
pnpm test:benchmark
# Use the existing updated kind image; this experiment changes only worker concurrency.
bash scripts/kind-benchmark.sh --verify-concurrency
