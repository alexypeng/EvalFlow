# EvalFlow Helm chart

M5 is in progress. This first slice contains only Postgres; the API, worker,
reaper, migrations and autoscaling will follow. Docker Compose remains the full-stack setup.

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

Live installation, SQL connectivity and persistence across Pod replacement are pending the kind
setup checkpoint. Lint/render success does not prove runtime storage or database readiness.

References: [StatefulSets](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/),
[Postgres image](https://hub.docker.com/_/postgres),
[Helm charts](https://helm.sh/docs/topics/charts/).
