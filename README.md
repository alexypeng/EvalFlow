# EvalFlow

Local AI agent orchestration and evaluation platform.

EvalFlow is a local-only AI platform infrastructure project. It demonstrates how an LLM workflow can be wrapped in backend systems for asynchronous execution, durable job state, tool invocation, structured output validation, eval scoring, retry behavior, traces, token usage, latency tracking, and dashboard observability.

The first workflow, `retention_risk_analysis`, simulates an analytics agent that gathers product usage data, calls an LLM provider, validates the response, evaluates output quality, and stores the full execution record in PostgreSQL.

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [Environment Variables](#environment-variables)
- [Architecture](#architecture)
- [Workflow](#workflow)
- [Data Model](#data-model)
- [Reliability and Observability](#reliability-and-observability)
- [API](#api)
- [Screenshots](#screenshots)
- [Roadmap](#roadmap)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Background

Many AI demos stop at sending a prompt to a model. EvalFlow focuses on the infrastructure around the model call: job orchestration, persistence, worker processing, retries, tool traces, schema validation, eval scoring, and operational metrics.

The supported workflow is retention risk analysis. A user submits a `userId`; the worker gathers mock analytics data such as user events, feature usage, subscription history, and retention metrics; the LLM returns a structured risk analysis; Zod validates the output; and an evaluator scores whether the result is complete, supported, and reasonable.

Abstract dependencies:

- A dashboard submits and observes jobs.
- An API owns job creation, retrieval, retry, and metrics.
- PostgreSQL stores jobs, traces, and evals.
- A worker claims queued jobs and runs the agent pipeline.
- Mock analytics tools simulate product data sources.
- Gemini or a mock LLM provider generates structured output.

## Install

Run the full local stack with Docker Compose:

```bash
docker compose up --build
```

Then open:

```text
Dashboard:  http://localhost:5173
API:        http://localhost:3000
Prometheus: http://localhost:9090
Grafana:    http://localhost:3001
Postgres:   localhost:5432
```

Stop the stack with:

```bash
docker compose down
```

Remove local database state, collected metrics/traces and Grafana state if you want a clean reset:

```bash
docker compose down -v
```

### Dependencies

Required:

- Docker
- Docker Compose

Optional for local development outside Docker:

- Node.js
- pnpm
- PostgreSQL

Copy the example environment file when running processes outside Docker:

```bash
cp .env.example .env
```

For Docker, the compose file already uses the container database host:

```text
postgresql://postgres:postgres@postgres:5432/evalflow
```

For local development outside Docker, use localhost:

```text
postgresql://postgres:postgres@localhost:5432/evalflow
```

## Usage

Use the dashboard:

1. Open `http://localhost:5173`.
2. Enter a user ID, such as `user_123`, `user_medium`, `user_healthy`, or any custom value.
3. Click `Run analysis`.
4. Watch the job move through `queued`, `running`, and `completed`.
5. Inspect the retention analysis, eval score, traces, latency, token usage, and result JSON.

Create a job directly through the API:

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"type":"retention_risk_analysis","input":{"userId":"user_123"}}'
```

Example job input:

```json
{
  "type": "retention_risk_analysis",
  "input": {
    "userId": "user_123"
  }
}
```

Example structured result:

```json
{
  "summary": "User user_123 has high retention risk based on recent activity, feature usage, subscription state, and NPS.",
  "retentionRisk": "high",
  "evidence": [
    "Active days changed from 18 to 4.",
    "Support tickets in last 30 days: 2.",
    "NPS score is 4."
  ],
  "recommendedActions": [
    "Schedule customer success outreach.",
    "Offer a workflow review focused on underused features."
  ]
}
```

Unknown users use fallback mock analytics data, so entering a value like `user_5` still exercises the full pipeline.

## Environment Variables

`.env.example` contains the local development variables:

```text
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/evalflow
DOCKER_DATABASE_URL=postgresql://postgres:postgres@postgres:5432/evalflow
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash
LLM_PROVIDER=mock
RATE_LIMIT_MOCK=false
PORT=3000
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5433/evalflow_test
WORKER_CONCURRENCY=1
LEASE_DURATION_MS=60000
HEARTBEAT_INTERVAL_MS=20000
WORKER_SHUTDOWN_TIMEOUT_MS=30000
WORKER_SHUTDOWN_CLEANUP_MS=5000
WORKER_STOP_GRACE_PERIOD=40s
REAPER_INTERVAL_MS=5000
REAPER_BATCH_SIZE=100
```

`LLM_PROVIDER=mock` is the default so the project can run locally without an API key. Use `LLM_PROVIDER=gemini` and set `GEMINI_API_KEY` to call Gemini instead of the mock provider. `GEMINI_MODEL` selects the model (see [Gemini models](https://ai.google.dev/gemini-api/docs/models)).

Gemini calls use `@google/genai`. Token counts currently remain character-based estimates, and estimated cost is
zero; they do not yet use the provider's usage metadata or pricing.

`WORKER_CONCURRENCY` is the number of jobs one worker process runs at once.

`LEASE_DURATION_MS` defaults to 60000; `HEARTBEAT_INTERVAL_MS` defaults to 20000 and must be
a positive integer smaller than the lease duration. Both are worker settings in milliseconds.
The worker renews each active claim while waiting for tools or the model. Docker Compose accepts
these settings from the root `.env`; locally, set them in the worker environment.

The worker handles SIGTERM and Ctrl+C (SIGINT) by stopping new claims, waking idle polling and
giving active jobs up to `WORKER_SHUTDOWN_TIMEOUT_MS` (default 30000) to finish. Heartbeats continue
during this drain period so slow calls retain ownership. A claim already sent before the signal can
return afterwards; the worker releases it without starting its pipeline, retaining the consumed attempt.

At the deadline, unfinished attempts stop starting further pipeline steps and their heartbeats are
stopped/drained. A guarded release uses the normal backoff/dead-letter policy without resetting attempts.
Completion already in progress and release serialize through the same row locks; only one transition wins.
Release cannot touch another worker's replacement claim. Provider calls may continue remotely even after
the local process exits, so an interrupted attempt still counts and may have incurred provider cost.

`WORKER_SHUTDOWN_CLEANUP_MS` (default 5000) bounds release/disconnect cleanup after the drain deadline.
If cleanup stalls, the process exits with code 1; unrenewed leases are recovered by the separate reaper.
Successful drain or completed deadline cleanup exits with code 0. Repeated signals do not extend the deadline.
Both worker shutdown settings are positive integer milliseconds, with a maximum of 2147483647.
Compose runs Node directly to deliver signals to the worker and allows `WORKER_STOP_GRACE_PERIOD`
(default `40s`) before a forced kill. If you increase shutdown budgets, set this Docker duration longer
than their combined total. SIGKILL cannot be handled and still relies on lease expiry/reaper recovery.

The separate reaper recovers jobs after worker crashes. Docker Compose starts it as the `reaper`
service. For development outside Docker, run `pnpm dev:reaper` in another terminal alongside
the API and worker, using the same `DATABASE_URL`. For compiled code use
`pnpm --filter server start:reaper` after building.

`REAPER_INTERVAL_MS` defaults to 5000 (1–2147483647); `REAPER_BATCH_SIZE` defaults to 100
(1–1000). Each scan handles at most that many expired jobs, then waits for the interval.
Multiple reapers may run safely: row locks with `SKIP LOCKED` keep them from recovering the same
claim twice. The reaper needs Postgres access and no LLM API key.

`TEST_DATABASE_URL` is the database used by `pnpm test`. Start it locally with `docker compose --profile test up -d postgres-test`. The name must end in `_test`, since tests truncate tables.

The suite includes worker chaos recovery tests. To run only those tests:

```bash
pnpm --filter server test:chaos
CHAOS_SEED=7 pnpm --filter server test:chaos
```

The main scenario creates 20 valid mock dataset jobs and starts three real workers plus a separate
reaper. Shared mock rate limiting is enabled. Four times, it chooses an active worker after an observed
LLM admission, sends SIGKILL and starts a replacement. A fixed seed controls target choices and short
pauses; OS scheduling and database backoff jitter still vary. The default seed is 20261015, also set in CI.
Short test leases/heartbeats speed recovery without changing the production retry/backoff code.

After fault injection stops, all 20 jobs must complete with a saved result, exactly one evaluation each,
cleared ownership and one observed accepted-completion log each. Retried jobs must show fresh claim
tokens. Jobs get six attempts so four injected crashes cannot legitimately exhaust the main recovery
batch. A separate one-attempt scenario kills an active worker and asserts dead_letter with no result/eval.
Execution may repeat after crashes; these tests check one accepted completion, not exactly-once LLM calls.

The harness kills only subprocesses it started and cleans them up on success/failure. Internal phase
deadlines leave time for cleanup before test timeouts; failures include the seed, job states and bounded
worker/reaper logs. The normal `pnpm test`/CI server-test step includes both chaos scenarios, with a
five-minute CI step limit. Tests use only `evalflow_test` and mock calls, with no live Gemini requests.

`DATABASE_URL` differs depending on where the process runs:

- Inside Docker Compose, services use `postgres` as the database host.
- Outside Docker, local processes use `localhost` as the database host.

## Run a dataset from the CLI

With the API and worker running and the dataset loaded:

```bash
pnpm --silent evalflow run --dataset retention --dataset-version 1 --prompt v2
```

The command creates one run, polls its report until all jobs are completed or dead-lettered, and prints the finished
report as JSON to stdout. Progress and the run ID go to stderr. Use `--api-url` to choose another API,
`--poll-ms` to change the delay between polls, and `--timeout-ms` to change the total deadline (default two minutes).
`pnpm --silent evalflow --help` lists the options. The `--silent` flag suppresses pnpm's script output.

After a server build, the compiled entry point is `node server/dist/cli.js`; the server package also declares
the `evalflow` binary at `dist/cli.js`.

Without `--baseline`, the CLI exits 0 when it retrieves a finished report, including runs with failed cases;
input/API/timeout errors exit 2. Use the compiled command directly when exact exit codes matter: pnpm can map a child
error to exit 1. A timeout stops waiting but does not cancel
the server's jobs. Creation requests are never automatically retried, because a lost response could still have created
a run.

## Export a baseline

Export a finished run for comparison in a fresh CI database:

```bash
mkdir -p baselines
pnpm --silent evalflow baseline export <runId> --output baselines/retention-v1.json
```

Omit `--output` to print JSON to stdout. The output directory must already exist; an existing file is never overwritten.
The compiled equivalent is `node server/dist/cli.js baseline export <runId> --output <file>`.
The read-only API route is `GET /runs/:id/baseline`: unknown runs return 404, and unfinished or missing case results return
409. Queued/running cases cannot be exported; dead-lettered jobs are terminal and exported as failed outcomes.

The versioned format contains `formatVersion: 1`, dataset name/version, saved prompt/provider/model/mock settings,
and sorted `cases` with `caseName`, `outcome` (`pass` or `fail`) and `score` (nullable for dead-lettered jobs). Passing cases
must have a score. Each case uses its latest evaluation, matching the existing report/comparison rules. Case names
are portable across databases; database run/dataset/case IDs are omitted. This exports stored results and does not
rerun the model. Saved nonzero mock failure rates still select cases using database case IDs, so the same seed can
select different failures in a fresh database.

## Check for regressions

After building the server, compare a new dataset run against a saved baseline:

```bash
node server/dist/cli.js run --dataset retention --dataset-version 1 --prompt v2 \
  --baseline baselines/retention-v1.json
```

`--baseline` accepts a JSON file or a finished run UUID from the API's database. File paths that look like UUIDs
can use a `./` prefix. Baseline contents and dataset name/version are checked before the candidate is created.
After it finishes, all case names must match exactly: missing, extra or duplicate names are errors.

The compiled CLI exits 0 for no regressions, 1 for any pass-to-fail regression, or 2 for invalid/incompatible data,
API errors and timeouts. Improvements and lower scores on still-passing cases (warnings) are reported without blocking.
An existing failed case remaining failed does not block. With `--baseline`, stdout is JSON containing `report` and
`comparison` (per-case changes, counts, saved settings and exit code); progress goes to stderr. Without the flag,
the original report-only behavior remains. The dashboard and gate share the case classification rule.

Prompt/provider/model and mock settings are recorded but may differ between the baseline and candidate, so the gate
can evaluate intentional changes to them. Dataset compatibility currently checks name, version and case names; it
does not hash the underlying snapshots or labels. Dataset content changes must use a new version.
### Markdown summary

Use `--format markdown` on a gate run to write a summary suitable for a GitHub check or PR comment:

```bash
node server/dist/cli.js run --dataset retention --prompt v2 \
  --baseline baselines/retention-v1.json --format markdown > summary.md
```

The summary includes the gate verdict, candidate run ID, dataset/settings, classification counts, regressed cases,
warnings, and candidate-minus-baseline changes in passed cases, pass rate and mean recorded score. Pass-rate changes
use percentage points. Missing scores are excluded from the mean, with the scored-case count shown; unavailable values
use `—`. Baselines do not store latency, tokens or cost, so those comparison deltas are not available.

JSON remains the default output. Markdown requires `--baseline`, leaves progress on stderr, and preserves the native
0/1/2 exit codes. A regression still writes its summary before exiting 1. Validation/API errors exit 2 without a summary.
Dynamic names/settings are escaped so they cannot break tables or insert HTML.

### GitHub Actions regression check

`.github/workflows/regression.yml` runs on pushes and PRs alongside the existing test/build workflow. It uses a fresh
Postgres service and the mock provider with no Gemini key. `scripts/ci-regression.sh` builds the server, applies
migrations, loads retention v1, starts API/worker processes, waits for API health, and runs prompt v2 against
`baselines/retention-v1.json`. It preserves the native gate exit code and stops its processes on exit.

The initial baseline was exported from a default mock v1 run: 20 cases, 16 passes, four judgment-case failures,
and zero configured mock failures. CI reads the baseline from the checked-out revision; changes to baseline files
need review alongside code changes. Baseline updates use the export command and must be intentional.

Every run publishes a check summary and an `evalflow-regression-report` artifact, retained for 14 days, including
the Markdown report and process/gate logs. Publication runs after failures too; setup/API errors produce an ERROR
summary rather than reusing an old report. The runner records its exit code in `exit-code.txt`.

A separate job posts or updates one marked PR comment for same-repository PRs. It downloads the report without
checking out or executing PR code and has PR-write permission; evaluation has only repository-read permission.
Fork and Dependabot PRs get the check summary/artifact, with commenting skipped. No custom token or API secret is needed.

To exercise the same runner locally with the dedicated test database:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5433/evalflow_test \
  PORT=3100 bash scripts/ci-regression.sh
```

Reports go to ignored `.evalflow-ci/`. `EVALFLOW_REPORT_DIR` and `EVALFLOW_BASELINE_FILE` can select local QA output and
fixture baselines. The script does not start Postgres or install dependencies; CI handles those steps.
The mock ignores prompt text, so a prompt-only edit cannot demonstrate a failing gate. Changes to predictions,
validation or evaluation can produce regressions; real prompt evaluation requires the Gemini provider separately.

## Architecture

```text
React dashboard
  -> Node/Fastify API
    -> PostgreSQL jobs/traces/evals
      -> Node worker
        -> mock analytics tools
        -> Gemini or mock LLM provider
        -> Zod structured validation
        -> eval scoring
        -> PostgreSQL result/traces/metrics
          -> React dashboard polling
```

The API does not execute LLM work inline. It creates durable jobs in PostgreSQL. The separate worker process polls for queued jobs, claims one safely, executes the workflow, and writes results back to the database.

## Workflow

The first supported workflow is `retention_risk_analysis`.

Input:

```json
{
  "type": "retention_risk_analysis",
  "input": {
    "userId": "user_123"
  }
}
```

The worker executes these steps:

1. Claim the oldest queued job.
2. Mark it `running` and increment attempts.
3. Call mock analytics tools for events, feature usage, subscription history, and retention summary.
4. Build an analytics snapshot and prompt.
5. Call the configured LLM provider.
6. Parse and validate structured JSON with Zod.
7. Score the output with the eval rubric.
8. Save result, traces, token usage, latency, eval details, and status.
9. Retry execution errors until `maxAttempts`, then mark jobs `dead_letter`.

Expected LLM result shape:

```json
{
  "summary": "string",
  "retentionRisk": "low | medium | high",
  "evidence": ["string"],
  "recommendedActions": ["string"]
}
```

## Data Model

`jobs` stores the lifecycle and summary of each run:

- job type and input
- status: `queued`, `running`, `completed`, `dead_letter`
- attempts and max attempts
- result or error
- latency and token usage
- estimated cost
- eval score

`traces` stores step-level observability:

- analytics tool calls
- LLM call input and output
- per-step latency

`evals` stores quality checks:

- valid JSON
- required fields present
- evidence included
- evidence supported by mock data
- reasonable risk label
- task completion score
- notes

## Reliability and Observability

EvalFlow includes basic reliability behavior expected in backend AI systems:

- Jobs are persisted in PostgreSQL instead of memory.
- The API and worker run as separate processes.
- The worker claims due queued jobs with database locking, a worker identity and a fresh claim token.
- Heartbeats extend live leases; expired or replaced claims cannot complete, fail or renew jobs.
- Completion saves the result and evaluation together in one transaction.
- Attempts are incremented when work is claimed.
- Execution errors are retried until `maxAttempts`.
- Jobs are marked `dead_letter` after retries are exhausted.
- Dead-lettered jobs can be manually requeued from the API or dashboard.

The separate reaper checks expiry using database time. It requeues expired running jobs with attempts
remaining using the backoff policy below and marks exhausted jobs `dead_letter`, clearing ownership in either
case. Recovery does not increment attempts; the next claim does. With the default settings, an unrenewed lease expires after
60 seconds and becomes eligible for the next scan (every 5 seconds, subject to batch backlog and locks).
If the reaper is offline, expired jobs wait until it returns. SIGTERM/SIGINT stop scans, finish the
current database operation and disconnect.

Lease loss stops further pipeline steps once detected; an already running model call may
still finish, but its result is rejected. Traces include the worker identity and claim token so attempt
history remains distinguishable.

Automatic retries from worker errors and expired-lease recovery use exponential backoff with jitter.
After attempt 1, the wait is 1–2 seconds; after attempt 2, 2–4 seconds; then 4–8, 8–16 and
15–30 seconds for attempt 5 onward. The exponential ceiling caps at 30 seconds; a random delay
between half and all of that ceiling spreads retries across jobs. Delays are chosen in whole milliseconds.
Both paths save `run_after` using Postgres time in the same operation that requeues the job and clears
ownership. Workers skip future jobs, so waiting consumes no worker slot and survives process restarts.
Actual execution can start later because of polling or queue backlog. Attempts increment only on claim.
Exhausted jobs remain `dead_letter`; manually retrying one resets attempts and makes it immediately eligible.
These delays reduce retry pressure during failures. The shared provider rate limiter below also paces normal calls.

Worker LLM admission uses a Postgres token bucket per resolved provider. Each permit allows one call;
these permits are unrelated to prompt/completion text tokens. The initial bucket policy is one permit
per second and a capacity of two, allowing a short two-call burst followed by gradual refill. Policy
and balance are stored together in `provider_rate_limits`, shared by every worker using that database;
restarting workers does not reset the balance. These are demonstration defaults, not Gemini quota values.
This checkpoint initializes policy in the database and has no policy-editing API; policy changes should
go through a reviewed migration so workers agree on one policy.

Gemini worker calls always acquire a permit. Mock calls are unlimited by default; to demonstrate the
same limiter locally, run `RATE_LIMIT_MOCK=true pnpm dev:worker` in each worker terminal, or set
`RATE_LIMIT_MOCK=true` for the Compose worker. All workers in a mock demonstration should use the
same setting. Missing Gemini credentials resolve to mock and use the mock policy/setting.

Permit acquisition locks the bucket and checks the current job lease before spending. Refill uses database
time and caps at capacity. When empty, the transaction ends before sleeping; the job remains running,
occupies its worker slot and keeps heartbeats. Waiting does not claim again or increment attempts.
Shutdown interrupts permit waiting and uses the normal retry/dead-letter path; lease loss discards the
attempt. An acquired but unused permit is not refunded because a paused/crashed worker cannot prove
whether it sent a request. A `provider_rate_limit` trace records successful admission wait time with zero
text tokens/cost, separately from `llm_call`. End-to-end job latency includes the wait.

Gemini SDK internal retries are disabled: execution retries return through the queue, backoff and a new
permit. Database errors do not bypass the limiter. This controls request admission in EvalFlow workers;
provider token/day quotas, other API clients and strict external request-arrival timing remain separate.
Before running updated workers on an existing dev database, apply migrations with
`pnpm --filter server exec prisma migrate deploy`. The new table has been verified in `evalflow_test`.

Dead letters stay in the same `jobs` table, retaining their error and attempt history in traces. In the
Single job dashboard, open History and choose Dead letters, select a job to inspect its error/traces,
then choose Requeue job after addressing the cause. Requeue resets attempts, clears the current error
and execution results, and preserves historical traces and evaluations. It does not fix the original cause.

`GET /jobs?status=dead_letter` returns the latest 100 matching jobs (filtering happens before the limit).
Other supported filters are `queued`, `running` and `completed`; invalid statuses return 400. The existing
`POST /jobs/:id/retry` endpoint accepts only dead-lettered jobs (409 for other states, 404 if absent).
Run reports retain `jobs.failed`, and metrics retain `failedJobs`, as counts of dead-lettered jobs.
Comparisons/baselines continue treating those jobs as failed outcomes, so the CLI gate contract is unchanged.

The migration renames the old `failed` enum value in place, preserving existing rows and references.
Before running updated code against an existing development database, stop the old API, workers and
reaper, run `pnpm --filter server exec prisma migrate deploy`, then restart them with the updated code.
Old binaries use the previous enum value and must be upgraded together. Docker Compose runs migrations
before starting its services. The migration was verified on the test database; apply it to your dev DB when ready.

EvalFlow also stores observability data for each run:

- tool traces
- LLM trace
- validation errors
- eval details
- prompt tokens
- completion tokens
- total tokens
- estimated cost
- job latency

## API

### Dataset runs and mock failure settings

The dashboard opens on **Dataset runs**. Choose a loaded dataset and prompt version, optionally
enable mock failure settings, then select **Start run**. Each dataset case becomes a queued job.
Run progress and results refresh every two seconds. Select a run ID to inspect pass rate, score,
latency percentiles, tokens, cost and saved settings. Use **Single job** for the original analysis,
job history, traces and retry flow.

Select **Use as baseline** on a reference run, then choose a candidate of the same dataset version
in **Compare runs**. The table shows per-case outcomes and scores; filter it to inspect regressions,
improvements, warnings or pending cases. Pending results stay visible until both cases finish.

`GET /datasets` lists loaded dataset versions and case counts. `GET /runs` returns the latest 50
run reports; use `?limit=<1–100>` to change the page size. Runs are newest first. Pass rate uses
all cases as the denominator, including unfinished ones; mean score, latency, tokens and cost use
completed jobs. Mock failures simulate a change in behavior and do not measure the effect of prompt
text on a real model.

Load the fixture with `pnpm --filter server dataset:load datasets/retention-v1.json`, then create a run:

```bash
curl -X POST http://localhost:3000/runs \
  -H "Content-Type: application/json" \
  -d '{
    "datasetName": "retention",
    "datasetVersion": 1,
    "promptVersion": "v2",
    "mockConfig": {
      "seed": "demo",
      "wrongLabelRate": 0.25,
      "invalidJsonRate": 0,
      "missingEvidenceRate": 0,
      "latencyMs": 100
    }
  }'
```

`mockConfig` is optional and only accepted when the resolved provider is mock. Rates range from 0 to 1;
0 disables a failure and 1 selects every case. Rates default to 0, latency to 0 (maximum 60,000 ms),
and seed to `evalflow`. The run saves the normalized settings and copies them into every job.

Each failure uses a separate hash of the seed and case ID. The same settings select the same cases
across retries and worker ordering; rates are probabilities, not exact case counts. Reloading the dataset
into a fresh database creates new case IDs and can change the selection. Changing prompt versions alone
does not change the mock's predictions.

Wrong-label mode rotates the mock's predicted risk to another label without reading the answer key.
It can accidentally correct an existing mistake. Missing-evidence mode produces an empty evidence array,
which fails schema validation. Invalid JSON takes precedence if both modes select a case. These two
validation failures retry normally and eventually fail; their calls retain token usage and timing in traces.
Added latency is included in the LLM-call trace and completed-job latency.

Use `GET /runs/<run_id>` for a report (including settings), and
`GET /runs/<baseline_id>/compare/<candidate_id>` for per-case changes. For a reproducible regression demo,
create a baseline without failure settings and a candidate with `wrongLabelRate: 1` on the same dataset.
These are simulated failures rather than evidence that a prompt performs worse on a real provider.

### Jobs

Create a job:

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -d '{"type":"retention_risk_analysis","input":{"userId":"user_123"}}'
```

List jobs:

```bash
curl http://localhost:3000/jobs
```

Get job details:

```bash
curl http://localhost:3000/jobs/<job_id>
```

Requeue a dead-lettered job:

```bash
curl -X POST http://localhost:3000/jobs/<job_id>/retry
```

Get aggregate metrics:

```bash
curl http://localhost:3000/stats
```

The dashboard reads these database aggregates as JSON. API request measurements are available separately:

```bash
curl http://localhost:3000/metrics
```

This endpoint returns Prometheus text using `@prometheus-io/client` (the current name of `prom-client`).
`evalflow_http_requests_total` counts completed responses, and `evalflow_http_request_duration_seconds`
records their durations in cumulative histogram buckets from 5 milliseconds to 10 seconds, plus an
unbounded bucket. Both use `method`, `route` and `status_code` labels. Route patterns such as `/jobs/:id`
group different IDs together; unknown URLs share `unmatched`. Raw paths, query strings and job IDs
are never labels. Scrapes of `/metrics` are excluded from both measurements.

HTTP measurements live in each API process and reset on restart; they do not reconstruct past requests from
Postgres. Job counts use a separate `evalflow_jobs{status="..."}` gauge, read from Postgres on every
scrape in one grouped query. It always exposes queued, running, completed and dead_letter, including zero
for empty statuses. Queued includes jobs waiting for retry backoff; running includes claimed jobs whose
expired leases may still await the reaper. Counts include all stored jobs, including dataset runs.
These are current counts, not lifetime event counters: manual requeue or deletion can reduce terminal
counts. An API restart reads them again from Postgres. If the database read fails, `/metrics` returns 500
instead of publishing stale or false zero job counts; Prometheus marks that scrape DOWN. Worker attempt
measurements are exposed separately as described below.
See the [client documentation](https://github.com/prometheus/client_js)
for the metric types and exposition format.

### Local Prometheus

Docker Compose includes Prometheus, which scrapes the API every 15 seconds with a 5-second timeout.
Its target is `http://api:3000/metrics`: `api` is the Compose service name. Inside the Prometheus
container, `localhost` would refer to Prometheus itself, rather than the API container.

```bash
docker compose up --build -d api prometheus
```

This also starts Postgres and applies migrations through the existing API dependencies.
The API must run in Compose for this target to resolve; an API started with `pnpm dev:api` on the
host is not the configured target. Configuration lives in `observability/prometheus/prometheus.yml`.
After editing it, run `docker compose restart prometheus` to load the changes.

Open [Prometheus](http://localhost:9090) and its [targets page](http://localhost:9090/targets).
The `evalflow-api` target should become **UP** after a scrape. Generate a few read-only requests:

```bash
curl http://localhost:3000/jobs/not-a-uuid
curl http://localhost:3000/jobs/another-invalid-id
```

These return 404 without querying Postgres and still produce request measurements. Wait at least
15 seconds, then try these expressions in Prometheus's query page:

```promql
up{job="evalflow-api"}
evalflow_http_requests_total{job="evalflow-api"}
sum(rate(evalflow_http_requests_total{job="evalflow-api"}[5m]))
histogram_quantile(0.95, sum by (le) (rate(evalflow_http_request_duration_seconds_bucket{job="evalflow-api"}[5m])))
```

`up` is 1 when the latest scrape succeeds and 0 when it fails. The counter shows observed totals
since each API process started. `rate` estimates requests per second from successive samples;
it needs at least two samples, so wait for multiple scrapes and generate traffic before expecting
a useful rate or latency estimate. The histogram query estimates the 95th-percentile response time
in seconds across all API routes. Empty latency data can display `NaN` until requests are observed.

Prometheus keeps samples for 7 days in the `evalflow_prometheus` named volume. Ordinary restarts
and `docker compose down` preserve it; `docker compose down -v` removes it along with the database
volume. API restarts reset API counters, while Prometheus retains collected history and `rate`
accounts for counter resets. Requests between the last scrape and a crash may never be collected.
The Prometheus port is published only on the local machine.
See the official [configuration](https://prometheus.io/docs/prometheus/latest/configuration/configuration/)
and [Docker storage](https://prometheus.io/docs/prometheus/latest/installation/) documentation.

### Local Grafana

Start the API and monitoring services:

```bash
docker compose up --build -d api worker reaper prometheus grafana
docker compose restart prometheus
```

Open [Grafana](http://localhost:3001/d/evalflow-api). The **EvalFlow API** dashboard and its
Prometheus connection are configured automatically from `observability/grafana/`. Grafana queries
`http://prometheus:9090` over the Compose network; the browser does not need to reach that container
hostname. Grafana displays the history Prometheus collected, rather than scraping the API itself.

The dashboard refreshes every 15 seconds and initially shows the last 15 minutes:

| Panel | Meaning |
| --- | --- |
| API availability | Latest scrape status: UP or DOWN. Success now includes the job-count DB query, but does not prove worker health or every database operation. |
| API traffic | Completed HTTP responses per second across API routes. Metrics scrapes are excluded. |
| Server errors (5xx) | Percentage of completed responses returning 5xx. Responses such as 404 contribute to traffic but are not server errors. |
| API response latency | Estimated p50 and p95 HTTP durations. A p95 of 100ms means about 95% of measured requests were faster than 100ms. |
| Queued and running jobs | Current waiting and claimed job counts. Queued includes delayed retries. |
| Completed and dead-letter jobs | Current stored terminal job counts, rather than a completion rate. |
| Worker attempt outcomes | Observed ended claims per second, grouped by outcome across workers. A retry followed by success is two attempts. |
| Worker attempt duration | Estimated p50/p95 from claim return to outcome observation, including permit waits and processing but excluding queued delay. |
| Provider permit wait | Estimated p50/p95 time acquiring a rate-limit permit, by provider and outcome. |
| LLM call duration | Estimated p50/p95 time inside the LLM call wrapper, by provider and outcome. |

Use the read-only request examples above to produce traffic, then wait for multiple Prometheus scrapes.
Rates need at least two samples for a series. The 5xx panel shows zero when traffic exists without
server errors; without traffic, a percentage or latency estimate is undefined and may show no data.
Missing samples are not filled with zeros. The HTTP panels measure API requests, not completed jobs,
queue wait or the duration of an LLM call. The job panels show database counts sampled every 15 seconds;
transitions between scrapes may not appear. They use `max by (status)` so future API replicas that read
the same shared database do not multiply the totals. Grafana chooses its rate window from the chart resolution
and the configured 15-second scrape interval.

This local setup provides anonymous **Viewer** access, disables login and sign-up, and creates no
initial admin account. Port 3001 is published only on loopback. Dashboard and data-source definitions
are read-only files; edit them in the repository instead of saving UI edits. Grafana scans dashboard
files every 10 seconds; restart Grafana after changing data-source provisioning. Its named volume
`evalflow_grafana` preserves its own state across container replacement; measurement history remains
in Prometheus's separate volume. `docker compose down -v` deletes both and the Postgres volume.
See Grafana's official [provisioning documentation](https://grafana.com/docs/grafana/latest/administration/provisioning/).

### Local Tempo

Tempo stores distributed traces; Grafana queries Tempo to display the steps of one operation.
Prometheus continues to store the aggregate metrics used by the existing dashboard.
The current checkpoint prepares trace storage and viewing. The API and worker do not yet emit
OpenTelemetry traces; the existing Postgres `traces` table remains independent.

Start Tempo and refresh Grafana's provisioned data sources:

```bash
docker compose up -d --no-deps tempo grafana
docker compose restart grafana
curl --fail http://localhost:3200/ready
```

Readiness can take a few seconds after startup. Open [Grafana Explore](http://localhost:3001/explore)
and select **Tempo**. Once application instrumentation is added, search for traces or select the
trace-ID query and paste an ID to inspect its steps. An empty result now is expected without a
test trace or an instrumented application sending data.

The pinned `grafana/tempo:3.1.0` image runs all required components in one process, with local filesystem
storage suitable for development. Configuration lives in `observability/tempo/tempo.yml`.
Grafana uses `http://tempo:3200` on the Compose network; the same query/readiness endpoint is exposed
at `http://localhost:3200`. Trace senders use OTLP over HTTP at `http://tempo:4318/v1/traces`
inside Compose, or `http://localhost:4318/v1/traces` when running on the host. Port 4318 receives
traces; port 3200 queries them. Both host ports bind only to loopback.

The `evalflow_tempo` named volume mounts `/var/tempo`, keeping the write-ahead log, trace blocks
and runtime data across ordinary restarts and container replacement. A seven-day retention override
lets Tempo periodically remove expired trace blocks; this is not an exact per-trace deletion deadline
or a disk-size limit. `docker compose down -v` also deletes this volume. Anonymous usage reporting
is disabled. The provisioned `evalflow-tempo` datasource is read-only, and Prometheus remains the
default datasource. See the official [local deployment guide](https://grafana.com/docs/tempo/latest/set-up-for-tracing/setup-tempo/deploy/locally/linux/)
and [Tempo datasource configuration](https://grafana.com/docs/grafana/latest/datasources/tempo/configure-tempo-data-source/).

### Worker attempt measurements

Each worker exposes `/metrics` on `WORKER_METRICS_PORT` (default `9100`). Compose makes this port
available inside its network without publishing a host port. Prometheus's `evalflow-worker` scrape job
discovers the IPv4 addresses of the Compose `worker` service every 15 seconds and scrapes each instance
on port 9100. This also supports multiple Compose worker replicas; no Docker socket is mounted into
Prometheus. After updating the scrape configuration, restart Prometheus as shown above.

The worker exports `evalflow_worker_attempts_total{outcome="..."}` and a matching
`evalflow_worker_attempt_duration_seconds` histogram. Both use only the bounded `outcome` label:

| Outcome | Meaning |
| --- | --- |
| `completed` | The database accepted the fenced result/eval write. A wrong answer can still be a completed execution. |
| `retried` | The database accepted requeueing this consumed claim, including a graceful shutdown release. |
| `dead_letter` | The database accepted terminal failure after attempts were exhausted. |
| `lease_lost` | The worker discarded its attempt after rejected/uncertain ownership. This includes heartbeat failures that prevent safe continuation. |
| `unconfirmed` | Finalization failed without a confirmed database outcome, such as a database error while releasing a claim. |

Every claim gets its own timer and records at most one outcome and duration. Completion and shutdown
release writes are serialized within that claim so racing cleanup cannot misclassify an accepted
completion as lease loss. The existing database fencing still decides whether each write is valid.
Duration starts when claiming returns and ends when the outcome is observed; it includes tool/model
time, permit waiting and finalization, but excludes the preceding queue wait and any following retry
backoff. A claim returned after shutdown starts still consumes an attempt and is counted when released,
even though its pipeline never ran. In-progress claims have no duration sample yet.

These counters reset on worker restart and are operational measurements, not a durable audit log.
SIGKILL cannot record its interrupted claim; updates after the last scrape can also be lost on exit,
including graceful shutdown. Reaper actions do not increment these worker counters. Use stored job
counts and traces to investigate individual jobs. Worker metrics remain readable during a DB outage,
but successful scrapes alone do not prove that jobs can be processed.

Workers also export two separate histograms:

- `evalflow_provider_rate_limit_wait_duration_seconds`: time inside permit acquisition.
- `evalflow_llm_call_duration_seconds`: time inside `callLlm`, including calls that reject.

Both use bounded `provider` (`mock` or `gemini`) and `outcome` labels. `success` means the wrapped
operation returned, `error` means it rejected, `cancelled` means it raised an abort error, and
`lease_lost` means ownership could not safely continue. A returned LLM response counts as call success
even when later JSON/schema validation fails and the attempt retries. Errors raised by the LLM wrapper
before making a provider request are also call errors, rather than successful requests.

Each measurement ends before the following database trace write. Permit time includes database work,
polling and sleeping within permit acquisition; it excludes model execution. LLM time includes the
call wrapper's work and provider/mock response time; it excludes permit waiting, trace writes and
subsequent output validation. Disabled mock limiting creates no permit-wait observations. Pending calls
and waits have no finished duration yet; a kill or exit before the next scrape can lose observations.
The new Grafana panels display p50/p95 estimates by provider and outcome. Unused provider/outcome series
have zero observations and no finite percentile; they do not imply zero latency. The histograms use
10ms through 300s finite buckets plus an unbounded bucket.

For a worker started directly on the host, inspect `http://localhost:9100/metrics`. Give each additional
host worker its own `WORKER_METRICS_PORT`; Compose discovery does not scrape host processes.
Tests use port `0` so the OS allocates independent ports for subprocesses.

Health check:

```bash
curl http://localhost:3000/health
```

## Screenshots

### Initial Dashboard

![Initial dashboard](docs/screenshots/dashboard-initial.png)

### Completed Run

![Completed run](docs/screenshots/completed-run.png)

### Evaluation And Traces

![Evaluation and traces](docs/screenshots/eval-traces.png)

### CI Regression Gate

A temporary mock-code override changed `healthy_power_user` from pass/100 to fail/80. The gate exited 1 and
updated the PR summary while ordinary tests passed. The override was then removed and CI returned to green.

![GitHub PR summary showing the deliberate healthy_power_user regression](docs/screenshots/ci-regression-failure.png)

[Failing workflow run](https://github.com/alexypeng/EvalFlow/actions/runs/38471539384) ·
[Restored passing workflow run](https://github.com/alexypeng/EvalFlow/actions/runs/38475140863)

## Roadmap

- Add more analytics workflows.
- Add websocket or server-sent event updates instead of polling.
- Add richer eval datasets and regression tests.
- Add real analytics integrations behind the existing mock tool interface.
- Add better cost modeling for Gemini usage.
- Add exportable run reports.

## Maintainers

- Alex Peng, GitHub: `alexypeng`

## Contributing

This is a personal local-only resume project. Questions can be asked through the repository issue tracker if the repository is public.

Pull requests are not currently expected, but small fixes or suggestions are welcome. Contributions should keep the project focused on local backend AI infrastructure and avoid adding authentication, billing, vector databases, Kubernetes, real analytics vendor integrations, or deployment complexity.

## License

ISC © Alex Peng
