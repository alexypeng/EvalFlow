#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bash "$repo_root/scripts/kind-app-up.sh"
node "$repo_root/scripts/kind-backend-check.mjs"
