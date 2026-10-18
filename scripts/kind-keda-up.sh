#!/usr/bin/env bash
set -euo pipefail
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
kubeconfig="$repo_root/.evalflow-kind/kubeconfig"
# Reuse the isolated cluster/Secret setup; never touch the default kube context.
bash "$repo_root/scripts/kind-postgres-up.sh"
helm upgrade --install keda keda --repo https://kedacore.github.io/charts --version 2.21.0 \
    --kubeconfig "$kubeconfig" --kube-context kind-evalflow --namespace keda --create-namespace \
    --wait --timeout 300s
kubectl --kubeconfig "$kubeconfig" --context kind-evalflow wait \
    --for=condition=Available apiservice/v1beta1.external.metrics.k8s.io --timeout=120s
bash "$repo_root/scripts/kind-app-up.sh" --autoscaling
kubectl --kubeconfig "$kubeconfig" --context kind-evalflow -n evalflow wait \
    --for=condition=Ready scaledobject/evalflow-app-worker --timeout=120s
kubectl --kubeconfig "$kubeconfig" --context kind-evalflow -n evalflow get scaledobject,hpa
