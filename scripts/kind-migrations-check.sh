#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
kubeconfig="$repo_root/.evalflow-kind/kubeconfig"
export KIND_EXPERIMENTAL_PROVIDER=docker
kube() { kubectl --kubeconfig "$kubeconfig" --context kind-evalflow -n evalflow "$@"; }
app_helm() { helm "$@" --kubeconfig "$kubeconfig" --kube-context kind-evalflow --namespace evalflow; }
migration_history() {
    kube exec evalflow-postgres-0 -- psql -U postgres -d evalflow -Atqc \
        'SELECT migration_name, checksum, finished_at FROM _prisma_migrations
         WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name'
}

bash "$repo_root/scripts/kind-app-up.sh"
image_tag=$(cat "$repo_root/.evalflow-kind/server-image-tag")
expected=$(find "$repo_root/server/prisma/migrations" -name migration.sql -type f | wc -l | tr -d ' ')
applied=$(kube exec evalflow-postgres-0 -- psql -U postgres -d evalflow -Atqc \
    'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
[[ "$applied" == "$expected" ]] || { printf 'Migration count mismatch.\n' >&2; exit 1; }
before_history=$(migration_history)
before_job=$(kube get job evalflow-app-migrate -o jsonpath='{.metadata.uid}')

app_helm upgrade evalflow-app "$repo_root/deploy/helm/evalflow-app" \
    --set-string "image.tag=$image_tag" --wait --timeout 180s
after_job=$(kube get job evalflow-app-migrate -o jsonpath='{.metadata.uid}')
[[ "$after_job" != "$before_job" ]] || { printf 'Upgrade did not run a new migration Job.\n' >&2; exit 1; }
[[ "$(migration_history)" == "$before_history" ]] || { printf 'Rerun changed applied migration history.\n' >&2; exit 1; }
printf 'PASS: %s migrations applied; a new upgrade hook leaves applied history unchanged.\n' "$applied"

# Use an unresolvable host: migrate deploy can create a missing database, so a new name is not a failure.
failure_release=evalflow-migration-failure
existing_release=$(app_helm list --filter "^$failure_release$" -q)
if [[ -n "$existing_release" ]]; then
    printf 'Temporary failure release already exists; inspect/remove it before rerunning this check.\n' >&2
    exit 1
fi
test_dir=$(mktemp -d "${TMPDIR:-/tmp}/evalflow-migrations.XXXXXX")
cleanup() {
    status=$?
    trap - EXIT
    if [[ -n "${failure_started:-}" ]]; then
        app_helm uninstall "$failure_release" --wait --timeout 60s || true
        kube delete job "$failure_release-migrate" --ignore-not-found --wait=true --timeout=60s || true
    fi
    rm -rf "$test_dir"
    exit "$status"
}
trap cleanup EXIT
cp -R "$repo_root/deploy/helm/evalflow-app" "$test_dir/chart"
cat > "$test_dir/chart/templates/failure-sentinel.yaml" <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
    name: evalflow-migration-failure-sentinel
data:
    installed: "yes"
YAML
failure_started=true
if app_helm install "$failure_release" "$test_dir/chart" --set-string "image.tag=$image_tag" \
    --set-string database.host=evalflow-migration-unreachable.invalid --wait --timeout 180s; then
    printf 'Expected migration failure, but installation succeeded.\n' >&2
    exit 1
fi
failed=$(kube get job "$failure_release-migrate" -o jsonpath='{.status.conditions[?(@.type=="Failed")].status}')
[[ "$failed" == True ]] || { printf 'Installation did not fail through the migration Job.\n' >&2; exit 1; }
sentinel=$(kube get configmap evalflow-migration-failure-sentinel --ignore-not-found -o name)
[[ -z "$sentinel" ]] || { printf 'Normal resources installed despite hook failure.\n' >&2; exit 1; }
[[ "$(migration_history)" == "$before_history" ]] || { printf 'Failure check changed working database history.\n' >&2; exit 1; }
printf 'PASS: failing migration blocks normal resources; working database history is unchanged.\n'
