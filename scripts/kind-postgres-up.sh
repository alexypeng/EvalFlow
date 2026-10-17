#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cluster_name=evalflow
context_name=kind-evalflow
state_dir="$repo_root/.evalflow-kind"
kubeconfig="$state_dir/kubeconfig"
export KIND_EXPERIMENTAL_PROVIDER=docker

for tool in docker kind kubectl helm openssl; do
    command -v "$tool" >/dev/null || { printf 'Missing required tool: %s\n' "$tool" >&2; exit 1; }
done
docker info >/dev/null
umask 077
mkdir -p "$state_dir"
clusters=$(kind get clusters)
if ! printf '%s\n' "$clusters" | grep -Fxq "$cluster_name"; then
    kind create cluster --name "$cluster_name" --config "$repo_root/deploy/kind/cluster.yaml" \
        --kubeconfig "$kubeconfig" --wait 180s
else
    kind export kubeconfig --name "$cluster_name" --kubeconfig "$kubeconfig"
fi

kube() { kubectl --kubeconfig "$kubeconfig" --context "$context_name" "$@"; }
kube wait --for=condition=Ready node --all --timeout=180s
kube create namespace evalflow --dry-run=client -o yaml | kube apply -f -

# Reuse credentials on reruns: changing the Secret does not rotate an initialized database's password.
existing_secret=$(kube -n evalflow get secret evalflow-postgres-auth --ignore-not-found -o name)
if [[ -z "$existing_secret" ]]; then
    existing_claim=$(kube -n evalflow get pvc data-evalflow-postgres-0 --ignore-not-found -o name)
    if [[ -n "$existing_claim" ]]; then
        printf 'Postgres storage exists but its Secret is missing. Restore the original credentials first.\n' >&2
        exit 1
    fi
    postgres_password=$(openssl rand -hex 32)
    printf '%s' "$postgres_password" | kube -n evalflow create secret generic evalflow-postgres-auth \
        --from-file=postgres-password=/dev/stdin
    unset postgres_password
fi

helm upgrade --install evalflow "$repo_root/deploy/helm/evalflow" \
    --kubeconfig "$kubeconfig" --kube-context "$context_name" \
    --namespace evalflow --wait --timeout 180s
kube -n evalflow get pods,services,pvc
printf '\nPostgres is ready. Run: bash scripts/kind-postgres-check.sh\n'
