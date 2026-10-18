# EvalFlow application chart

This chart contains the migration hook, API Service and API/worker/reaper Deployments.
The local default is one replica of each process with the mock provider and no API key.
Optional KEDA autoscaling adjusts workers from Postgres demand. Monitoring remains in Compose.

## Two releases and startup ordering

The existing `evalflow` release owns Postgres and its retained storage. The new `evalflow-app`
release targets that existing database. This avoids a fresh-install cycle in which a pre-install
migration needs Postgres while Helm has not yet created Postgres's normal resources.

```text
Database release ready → application migration hook succeeds → application resources installed/updated
```

`scripts/kind-app-up.sh` first runs the database setup, then builds the existing server Dockerfile,
loads a uniquely tagged image into kind and installs/upgrades the application release. It uses
the private `.evalflow-kind/kubeconfig` and explicit `kind-evalflow` context throughout.
After the migration hook succeeds, Helm waits for the backend Deployments to become ready.
Local kind and learning state are excluded from the Docker build context.

```bash
bash scripts/kind-app-up.sh
```

Use Helm 4, kind, Docker, kubectl and openssl, as in the database setup. The local script fixes the
cluster, namespace and release names; the chart exposes database/image settings in `values.yaml`.
The default `Never` image pull policy expects the image to be loaded into kind. The script replaces
the preview `local` tag with a fresh timestamp/commit tag, even when building uncommitted source.
The successful image tag is recorded in the ignored `.evalflow-kind/server-image-tag` file.

## Backend processes and access

All three Deployments use the same backend image with separate entrypoints. Node runs directly
as PID 1, constructs the database URL from the existing Secret and imports its entrypoint in the
same process. API/worker startup still initializes OpenTelemetry before application imports.
Tracing export defaults to disabled because kind has no Tempo deployment; set
`telemetry.otlpEndpoint` to a reachable OTLP HTTP endpoint when adding trace collection.
The separate Compose monitoring stack is unchanged.

The API has a ClusterIP Service named `evalflow-app-api`, listening on port 3000 by default.
Worker health/metrics use port 9100 and reaper health uses 9101 inside their Pods.
Worker and reaper consume the shared database queue directly; they do not receive jobs from the API Service.

To open the kind API on a separate local port (leave this command running):

```bash
kubectl --kubeconfig .evalflow-kind/kubeconfig --context kind-evalflow -n evalflow port-forward service/evalflow-app-api 3002:3000
```

Then use `http://localhost:3002/health` or the existing `/jobs` API. Port 3002 avoids Compose's
default API port 3000. No frontend or external ingress is deployed by this chart.

## Health and shutdown

Each process has two endpoints:

| Endpoint | Check | Kubernetes action on repeated failure |
| --- | --- | --- |
| `/livez` | HTTP process responsiveness; no database query | Restart the container |
| `/readyz` | Database reachability and process not shutting down | Mark Pod unready; no restart |

Startup probes allow roughly 60 seconds for the process HTTP server to respond. Liveness checks
run every 10 seconds with three failures before restart; readiness checks run every three seconds.
Readiness uses a separate, lazy, single-connection pool with one-second connection and query limits,
so probe deadlines do not alter normal application query limits. Idle pool errors are handled and
probe connections close with their HTTP server. Errors return only `{ "ok": false }` with HTTP 503.
The API's original database-backed `/health` remains available. `/livez` and `/readyz` are excluded
from API traffic measurements and automatic tracing.

When Postgres is unavailable, the backend remains alive while readiness fails. The API Service loses
ready endpoints and database-dependent requests are unavailable until recovery. A readiness change
does not stop a worker or reaper loop: those already catch DB errors and back off before retrying.
Readiness checks connection availability, not successful job throughput or every database permission.

The API/reaper receive 15 seconds of Kubernetes termination grace. Worker grace is calculated from
its configured drain and cleanup budgets, rounded up, with five extra seconds: the default is
30 seconds drain + 5 seconds cleanup + 5 seconds margin = 40 seconds. Existing SIGTERM handling stops
worker claims and renews leases during drain. Readiness fails during shutdown; liveness remains a
process check. Rolling updates allow one extra Pod and keep the desired replica count available.

## Migration Job

The Job runs on `pre-install` and `pre-upgrade`. Helm waits for it to succeed before installing
or updating normal application resources. It runs `pnpm exec prisma migrate deploy` using the
migrations already present in the backend image. Prisma records successful migrations in
`_prisma_migrations`; rerunning applies pending work without replaying completed migrations.

Database settings come from values and the existing `evalflow-postgres-auth` Secret. A short Node
launcher constructs a properly escaped database URL in memory and passes it to Prisma; neither the
chart nor the setup script embeds the password in Helm values, command arguments or rendered YAML.
The image's working directory is `/app/server`, where Prisma finds its config and migrations.

The Job has no automatic retries and a 120-second active deadline. Its exit status follows Prisma's
exit status, so errors block installation. Kubernetes retains finished Jobs for up to one hour for
log inspection; the next hook attempt deletes its predecessor before creating a new Job.

```bash
kubectl --kubeconfig .evalflow-kind/kubeconfig --context kind-evalflow -n evalflow get jobs
kubectl --kubeconfig .evalflow-kind/kubeconfig --context kind-evalflow -n evalflow logs job/evalflow-app-migrate
helm list --kubeconfig .evalflow-kind/kubeconfig --kube-context kind-evalflow -n evalflow
```

On future application upgrades, existing Pods can continue running while the pre-upgrade migration
executes. Schema changes must remain compatible with that running version. Helm failure or rollback
does not undo applied SQL migrations. This chart does not automate destructive schema rollouts.

## Verification

These checks do not contact a cluster:

```bash
helm lint deploy/helm/evalflow-app --strict
helm template evalflow-app deploy/helm/evalflow-app --namespace evalflow
bash -n scripts/kind-app-up.sh scripts/kind-migrations-check.sh
```

The live checkpoint builds/loads the image and installs/upgrades the releases:

```bash
bash scripts/kind-migrations-check.sh
```

It checks the applied migration count against the repository and records completed migration names,
checksums and finish times. A subsequent application upgrade must create a different migration Job
without changing that completed history.

For the failure path, it copies the application chart into a temporary directory, adds a normal
ConfigMap sentinel and attempts a separate `evalflow-migration-failure` release against an unresolvable
database host. A missing database name alone is not a failure fixture: Prisma can create that database.
The migration must fail, the sentinel must remain absent and the working database's
completed history must stay unchanged. The test uninstalls its failure release, explicitly removes
its hook Job and removes its temporary chart. It refuses to reuse an existing failure release.
The working database/application releases remain installed; this migration check submits no jobs or live LLM calls.

The backend integration check builds/loads the image, deploys the release, then exercises the processes:

```bash
bash scripts/kind-backend-check.sh
```

Use the default single-replica settings and an idle local queue. It verifies API Service job submission
and worker completion, then scales only kind Postgres to zero. All backend Pods must become unready,
keep successful liveness and retain their UIDs/restart counts over 32 seconds; the API Service must
have no ready endpoints. It restores Postgres and proves job processing recovers. It also seeds one
expired final attempt for the separate reaper to dead-letter and deletes the worker Pod during a
12-second mock call to verify graceful drain, one accepted result and a ready replacement worker.
Its own jobs are removed afterward; the retention fixture dataset is loaded idempotently for the
delayed mock case and remains available. The live processes and kind cluster remain running.

This test temporarily interrupts the kind database and worker. Normal test failure restores the
database in cleanup; after a forcibly killed test, restore it manually if needed:

```bash
kubectl --kubeconfig .evalflow-kind/kubeconfig --context kind-evalflow -n evalflow scale statefulset evalflow-postgres --replicas=1
```

See [Helm hook lifecycle](https://helm.sh/docs/topics/charts_hooks/) and the
[Prisma migrate deploy command](https://www.prisma.io/docs/cli/v7/migrate/deploy), plus the
[database chart](../evalflow/README.md).

## Worker autoscaling

```bash
bash scripts/kind-keda-up.sh
```

This installs the official KEDA Helm chart pinned to 2.21.0 in namespace `keda`, waits for its
external metrics API, then deploys the application with `autoscaling.enabled=true`. KEDA adds its
CRDs, operator, metrics server, admission webhook and cluster permissions only to this local cluster.
The application owns a ScaledObject and TriggerAuthentication; credentials reference the existing
namespace Secret. The database hostname is fully qualified because KEDA runs in another namespace.
The local database uses `sslmode=disable`; this is a local learning setup.

| Setting | Local default |
| --- | --- |
| Demand | Eligible queued jobs plus running jobs |
| Target per worker | 1 job (worker concurrency is 1) |
| Worker bounds | 0–4 |
| Activation polling while at zero | 10 seconds |
| Idle-to-zero cooldown | 60 seconds |
| HPA nonzero scale-down stabilization | 30 seconds |

`files/worker-demand.sql` is the actual query embedded in the ScaledObject and tested against
Postgres. Delayed retries remain queued but do not count until `run_after <= CURRENT_TIMESTAMP`.
Completed and dead-letter jobs do not count. Running jobs count even if their lease has expired;
the reaper resolves that state. A query failure is a scaler error, not a fabricated zero count.

KEDA activates an idle Deployment; the generated Kubernetes HPA handles nonzero replica counts
using the external AverageValue metric. Desired capacity is approximately `ceil(demand / target)`,
limited to four here. The HPA usually reconciles every 15 seconds and has tolerance/rate policies;
this is not immediate scaling. The 30-second stabilization uses the highest recent recommendation;
the separate 60-second cooldown governs the final move to zero.

The worker Deployment omits `spec.replicas` when autoscaling is enabled so Helm does not overwrite
HPA decisions. Kubernetes may select busy workers for scale-down; existing SIGTERM draining,
heartbeats, fencing and reaper recovery still protect jobs. Four is a conservative local starting
cap, not a measured optimum or a guarantee that only four Pods exist during rolling updates/drain.
If worker concurrency changes, revisit the target and measure it in M6.

For later autoscaled image deployments, run `bash scripts/kind-app-up.sh --autoscaling`.
Running `kind-app-up.sh` without the flag explicitly returns to one fixed worker and removes the
application's ScaledObject/authentication; KEDA itself remains installed. The older backend and
migration checks use that fixed-worker mode. Do not submit unrelated jobs during the scaling demo:

```bash
bash scripts/kind-keda-check.sh
```

The bundled check verifies the shipped SQL against the dedicated test database, installs the stack,
waits for zero, observes a delayed retry over three polling intervals, makes it eligible, verifies its
second attempt completes once, and submits twenty 12-second mock jobs to exercise 0 → 4 → 0.
It checks one attempt/eval per burst job and removes its terminal jobs. An interrupted/failed demo
leaves unfinished jobs for inspection. An ignored `.evalflow-kind/keda-check-jobs.json` journal lets
the next run remove only its previous terminal fixtures and refuses to proceed while they are unfinished.
The fixture dataset remains idempotently loaded. Workers may
be absent while idle; API, reaper and Postgres remain running.

Watch the controllers and Pods in another terminal:

```bash
kubectl --kubeconfig .evalflow-kind/kubeconfig --context kind-evalflow -n evalflow get scaledobject,hpa,deployments,pods --watch
```

See the [KEDA PostgreSQL scaler](https://keda.sh/docs/2.21/scalers/postgresql/) and
[ScaledObject settings](https://keda.sh/docs/2.21/reference/scaledobject-spec/).


### Optional worker notification wakeups

Set `worker.wakeupMode=notify` in application values to enable a dedicated Postgres LISTEN connection
per worker process. The default remains `poll`. Notification mode uses a fixed1000ms idle backup check;
`worker.pollIntervalMs` controls polling-only mode. The migration hook installs a transactional queued-job
notification trigger before backend resources change. Use the existing release upgrade flow, preserving
your image, database and autoscaling values.

Notifications wake existing idle workers; SQL claiming/leases still assign jobs. With zero worker Pods,
KEDA's existing demand query and activation polling remain responsible for starting capacity. The listener
reconnects independently and ordinary backup claims continue during a listener outage. Account for the
extra connection per worker process when sizing Postgres. The M6 notification performance comparison
has not yet been run; prior polling evidence remains unchanged.
