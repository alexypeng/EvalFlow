#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
kubeconfig="$repo_root/.evalflow-kind/kubeconfig"
pod=evalflow-postgres-0
claim=data-evalflow-postgres-0
kube() { kubectl --kubeconfig "$kubeconfig" --context kind-evalflow -n evalflow "$@"; }
sql() {
    kube exec -i "$pod" -- sh -ec \
        'export PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=5 PGOPTIONS="-c statement_timeout=10000";
         exec psql -h evalflow-postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -Atq'
}

kube wait --for=condition=Ready "pod/$pod" --timeout=180s
old_pod_uid=$(kube get pod "$pod" -o jsonpath='{.metadata.uid}')
old_claim_uid=$(kube get pvc "$claim" -o jsonpath='{.metadata.uid}')
old_volume=$(kube get pvc "$claim" -o jsonpath='{.spec.volumeName}')
[[ -n "$old_volume" ]] || { printf 'Postgres claim is not bound.\n' >&2; exit 1; }

marker=$(openssl rand -hex 8)
schema="evalflow_smoke_$marker"
cleanup() {
    if ! printf 'DROP SCHEMA IF EXISTS %s CASCADE;\n' "$schema" | sql; then
        printf 'Could not remove diagnostic schema %s; remove it after database recovery.\n' "$schema" >&2
    fi
}
trap cleanup EXIT
sql <<SQL
CREATE SCHEMA $schema;
CREATE TABLE $schema.persistence_check (value text NOT NULL);
INSERT INTO $schema.persistence_check VALUES ('$marker');
SQL
before=$(printf 'SELECT value FROM %s.persistence_check;\n' "$schema" | sql)
[[ "$before" == "$marker" ]] || { printf 'Initial SQL read failed.\n' >&2; exit 1; }

printf 'Saved test row through evalflow-postgres:5432; replacing Pod %s.\n' "$pod"
kube delete pod "$pod" --wait=true --timeout=90s
kube wait --for=create "pod/$pod" --timeout=180s
kube wait --for=condition=Ready "pod/$pod" --timeout=180s

new_pod_uid=$(kube get pod "$pod" -o jsonpath='{.metadata.uid}')
new_claim_uid=$(kube get pvc "$claim" -o jsonpath='{.metadata.uid}')
new_volume=$(kube get pvc "$claim" -o jsonpath='{.spec.volumeName}')
[[ "$new_pod_uid" != "$old_pod_uid" ]] || { printf 'Pod was not replaced.\n' >&2; exit 1; }
[[ "$new_claim_uid" == "$old_claim_uid" && "$new_volume" == "$old_volume" ]] || {
    printf 'Replacement did not reuse the same claim and volume.\n' >&2; exit 1;
}
after=$(printf 'SELECT value FROM %s.persistence_check;\n' "$schema" | sql)
[[ "$after" == "$marker" ]] || { printf 'Persisted row was not recovered.\n' >&2; exit 1; }
printf 'PASS: new Pod UID, same PVC and volume, same saved row through the stable Service name.\n'
