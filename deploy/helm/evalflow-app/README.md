# EvalFlow application chart

This M5 slice contains the migration hook only. API, worker and reaper Deployments follow next.
A deployed Helm release at this stage means its migration hook succeeded; it does not mean the
application processes are running.

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
Local kind and learning state are excluded from the Docker build context.

```bash
bash scripts/kind-app-up.sh
```

Use Helm 4, kind, Docker, kubectl and openssl, as in the database setup. The local script fixes the
cluster, namespace and release names; the chart exposes database/image settings in `values.yaml`.
The default `Never` image pull policy expects the image to be loaded into kind. The script replaces
the preview `local` tag with a fresh timestamp/commit tag, even when building uncommitted source.
The successful image tag is recorded in the ignored `.evalflow-kind/server-image-tag` file.

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
The working database/application releases remain installed; no API/worker jobs or live LLM calls run.

See [Helm hook lifecycle](https://helm.sh/docs/topics/charts_hooks/) and the
[Prisma migrate deploy command](https://www.prisma.io/docs/cli/v7/migrate/deploy), plus the
[database chart](../evalflow/README.md).
