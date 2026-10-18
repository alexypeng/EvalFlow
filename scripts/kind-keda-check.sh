#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$repo_root"
pnpm --filter server exec vitest run --project db test/db/workerDemand.test.ts
bash scripts/kind-keda-up.sh
node scripts/kind-keda-check.mjs
