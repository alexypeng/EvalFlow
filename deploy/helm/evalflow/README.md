# EvalFlow Helm chart

M5 is in progress. This chart contains only Postgres; the API, worker,
reaper and autoscaling will follow. Docker Compose remains the full-stack setup.

The separate [application chart](../evalflow-app/README.md) now supplies the migration checkpoint
against this database. Its setup script installs the database release first.

## Render locally

Requires Helm and targets Kubernetes 1.32 or newer. These commands do not contact a cluster:

```bash
helm lint deploy/helm/evalflow --strict
helm template evalflow deploy/helm/evalflow --namespace evalflow
```

`Chart.yaml` identifies the package. `values.yaml` supplies configuration defaults.
Helm substitutes those values into the files under `templates/` to produce Kubernetes YAML.

## Postgres resources

- One StatefulSet runs `postgres:16`, matching Compose's major version. Replicas are fixed at one:
  increasing replicas would create separate databases, not configure Postgres replication.
- A headless Service supplies the stable in-namespace address `<release>-postgres:5432`.
  The StatefulSet uses that Service for its Pod identity. It has no host port or public exposure.
- The `data` volume claim template requests 1Gi with `ReadWriteOnce` access. The Pod mounts it at
  `/var/lib/postgresql/data`, with `PGDATA` in the `pgdata` subdirectory.
- Startup and readiness probes use `pg_isready` over TCP. Startup allows up to roughly two minutes;
  readiness removes an unready Pod from Service discovery. These probes do not validate application
  migrations or password authentication. Postgres gets 60 seconds for graceful shutdown.
- CPU/memory requests and limits reserve capacity and bound the container's resource use.
  The Pod does not mount a Kubernetes API service-account token.

The chart references an **existing Secret** in the release namespace. Defaults are
`evalflow-postgres-auth` and key `postgres-password`. It renders no password or Secret resource.
Create that Secret before installation; without it, Kubernetes cannot start the container.
Keep the password outside the repo. For separate releases, set separate Secret names.

The official image initializes the configured database/user/password on an empty data directory.
Changing Helm values or the Secret later does not migrate existing database names or rotate the
stored Postgres password. Keep the original credentials when reusing an existing volume.
Changing the Postgres major version requires a separate database upgrade procedure.

## Storage lifecycle

By default the claim uses the cluster's default StorageClass. Set
`postgres.storage.className` to choose one; an explicit empty string requests no class and requires
a matching statically provisioned volume. Without usable storage provisioning, the Pod stays Pending.

Both StatefulSet claim-retention policies are explicitly `Retain`. Pod replacement and StatefulSet
removal preserve the claim. Reinstalling under the same release name and namespace can reuse it.
Deleting the claim or its namespace can destroy the data, depending on the storage provisioner's
reclaim policy. Storage inside a kind node also does not survive deleting that cluster.
Retention is not a backup or database replication strategy.

## Run Postgres in kind

On macOS, install the command-line tools if needed and start Docker Desktop:

```bash
brew install kind helm
bash scripts/kind-postgres-up.sh
```

Run scripts from the repository root. You also need `kubectl` and `openssl` on PATH.
The setup script creates or reuses the Docker-backed kind cluster `evalflow`, namespace `evalflow`
and Helm release `evalflow`. It uses the pinned Kubernetes 1.34.11 node image from kind 0.33.0,
compatible with the local kubectl 1.34 client. It exposes no Postgres host port and does not connect
to the Compose database. Kubernetes's API is bound to loopback.

Connection credentials are stored in `.evalflow-kind/kubeconfig`, which is ignored by Git.
The script passes that file and the explicit `kind-evalflow` context to every Kubernetes/Helm command;
it does not modify your normal kubeconfig or current context.
It generates a random database password without printing it and creates the Secret only when absent.
Reruns reuse the cluster, credentials and storage, then upgrade/install the chart and wait for readiness.
If the database claim exists but its Secret was deleted, setup refuses to generate a replacement.
Recover the original password: initialization variables do not change an existing database password.

Inspect this cluster explicitly:

```bash
kubectl --kubeconfig .evalflow-kind/kubeconfig --context kind-evalflow -n evalflow get pods,services,pvc
```

## Prove persistence

```bash
bash scripts/kind-postgres-check.sh
```

This test deliberately deletes the local Postgres Pod, briefly interrupting database access.
Run one check at a time, when no other work needs this database.
It writes a random marker into a uniquely named diagnostic schema, connecting over TCP through
`evalflow-postgres` with password authentication. After normal Pod deletion, it waits for a ready
replacement and verifies a different Pod UID, the same claim UID and volume, and the original marker.
SQL runs inside the database Pod but uses the Service DNS name rather than a Unix socket or localhost.
This verifies DNS/authentication/persistence, not connectivity from a separately deployed API or worker.
The test drops its diagnostic schema afterward. On cleanup failure, it prints the schema name for
later removal. It does not touch application tables or apply Prisma migrations.

Successful Pod replacement demonstrates persistence within the existing cluster. It does not test
an ungraceful database crash, node loss, backup restoration or survival after cluster deletion.
The cluster stays running for the next M5 pieces.

To remove this local cluster deliberately (including its database data):

```bash
KUBECONFIG=.evalflow-kind/kubeconfig kind delete cluster --name evalflow
```

Lint/render success alone does not prove runtime storage or database readiness; use the live check above.

References: [StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/),
[Postgres image](https://hub.docker.com/_/postgres),
[Helm charts](https://helm.sh/docs/topics/charts/),
[kind quick start](https://kind.sigs.k8s.io/docs/user/quick-start/),
[pinned kind node image](https://github.com/kubernetes-sigs/kind/releases/tag/v0.33.0).
