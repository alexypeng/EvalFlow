#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
kubeconfig="$repo_root/.evalflow-kind/kubeconfig"
export KIND_EXPERIMENTAL_PROVIDER=docker

# Database resources must exist before the application's pre-install hook runs.
bash "$repo_root/scripts/kind-postgres-up.sh"
image_tag="m5-$(date -u +%Y%m%d%H%M%S)-$(git -C "$repo_root" rev-parse --short HEAD)"
image="evalflow-server:$image_tag"
docker build -f "$repo_root/server/Dockerfile" -t "$image" "$repo_root"
kind load docker-image "$image" --name evalflow
helm upgrade --install evalflow-app "$repo_root/deploy/helm/evalflow-app" \
    --kubeconfig "$kubeconfig" --kube-context kind-evalflow --namespace evalflow \
    --set-string "image.tag=$image_tag" --wait --timeout 180s
printf '%s\n' "$image_tag" > "$repo_root/.evalflow-kind/server-image-tag"
kubectl --kubeconfig "$kubeconfig" --context kind-evalflow -n evalflow logs job/evalflow-app-migrate
kubectl --kubeconfig "$kubeconfig" --context kind-evalflow -n evalflow get deployments,services
printf '\nBackend ready. Forward the API with:\n'
printf 'kubectl --kubeconfig .evalflow-kind/kubeconfig --context kind-evalflow -n evalflow port-forward service/evalflow-app-api 3002:3000\n'
