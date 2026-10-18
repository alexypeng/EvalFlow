#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
node --test benchmarks/test/*.test.mjs
run_trial() {
    if [[ "$(uname -s)" == "Darwin" ]]; then
        # Keep idle sleep from suspending Docker's clocks/heartbeats during measurement.
        caffeinate -i node scripts/kind-benchmark.mjs "$@"
    else
        node scripts/kind-benchmark.mjs "$@"
    fi
}
if [[ "${1:-}" == "--verify" && "$#" == 1 ]]; then
    run_trial --jobs 4
    run_trial
elif [[ "${1:-}" == "--verify-sweep" && "$#" == 1 ]]; then
    run_trial --sweep-smoke
    run_trial --sweep
elif [[ "${1:-}" == "--verify-polling" && "$#" == 1 ]]; then
    run_trial --polling-smoke
    run_trial --polling
else
    run_trial "$@"
fi
