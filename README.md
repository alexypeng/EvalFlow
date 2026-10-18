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
REAPER_HEALTH_PORT=9101
```

`LLM_PROVIDER=mock` is the default so the project can run locally without an API key. Use `LLM_PROVIDER=gemini` and set `GEMINI_API_KEY` to call Gemini instead of the mock provider. `GEMINI_MODEL` selects the model (see [Gemini models](https://ai.google.dev/gemini-api/docs/models)).

Gemini calls use `@google/genai`. Token counts currently remain character-based estimates, and estimated cost is
zero; they do not yet use the provider's usage metadata or pricing.

`WORKER_CONCURRENCY` is the number of jobs one worker process runs at once.


`WORKER_WAKEUP_MODE=poll` preserves polling-only behavior (the default). `POLL_INTERVAL_MS` defaults to
2000ms for host/Compose commands; kind sets 1000ms. Busy workers immediately claim again after finishing
work; the idle interval applies after an empty claim or an error.

`WORKER_WAKEUP_MODE=notify` adds LISTEN/NOTIFY wakeups with a fixed **1000ms backup check**, regardless of
`POLL_INTERVAL_MS`. Apply migrations before starting the updated worker. For host development:

```bash
WORKER_WAKEUP_MODE=notify pnpm dev:worker
```

For Compose, set `WORKER_WAKEUP_MODE=notify` in the root `.env`, then recreate the worker through the
normal `docker compose up --build` flow so the migration service finishes first. For Helm, set
`worker.wakeupMode=notify` in the application release values; its migration hook installs the trigger
before the updated backend rolls out. Defaults stay polling-only until the M6 comparison is reviewed.

The migration installs a jobs-table trigger on queued inserts and transitions back to queued.
It covers individual submissions, run fan-out, manual retries, worker retries, reaper recovery and
direct benchmark inserts. Postgres sends the empty-payload notification only when the writing transaction
commits; a rolled-back job sends none. Multiple changes in one transaction can coalesce into one wakeup.
Notifications carry no job input, result or claim token. See [Postgres NOTIFY semantics](https://www.postgresql.org/docs/16/sql-notify.html).

Each notification-enabled worker process uses one additional dedicated `pg` connection, separate from
its Prisma pool, to listen on `evalflow_jobs`. After LISTEN succeeds, it checks the saved queue, including
after reconnecting. A notification wakes every idle slot; existing `SKIP LOCKED` claims, leases and
fencing decide ownership. Notifications are hints, so duplicate/broadcast wakeups may produce empty claims.
A generation counter preserves notifications arriving between the start of a claim and registering an
idle wait. The listener connection does not execute pipeline work or remain inside a transaction.

Backup checks discover delayed retries when `run_after` becomes due and work whose notification was missed.
Listener failures retry registration at one-second intervals while ordinary claims continue; database
claim errors still sleep before retrying rather than spinning on notifications. SIGTERM/SIGINT interrupt
idle waits and reconnect delays, close the listener, and preserve the existing active-job drain behavior.
The listener is not a durable message queue and does not replace the Postgres jobs table or the reaper.
When KEDA has scaled workers to zero, no worker listener exists; KEDA's database checks still control startup.

The correctness tests include transaction commit/rollback, all queue-writing paths, real listener
termination/reconnect, wakeup races, concurrent processes/slots, future eligibility and shutdown.
The [same-build wakeup comparison](docs/benchmarks/2026-10-18-wakeup-comparison.md) measures both modes
on the same migrated image, with fresh polling controls. Older polling evidence remains unchanged.

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
It exposes process/readiness checks on `REAPER_HEALTH_PORT` (default 9101); use a distinct port
for each host reaper, or port 0 for an automatically allocated port. Compose does not publish it.

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
The API emits HTTP/Fastify spans and child Postgres query spans. Jobs carry that context through
Postgres so worker-attempt spans join the request trace. Each attempt includes pipeline and LLM
child spans. The existing Postgres `traces` table remains independent.

Start Tempo and refresh Grafana's provisioned data sources:

```bash
docker compose up -d --no-deps tempo grafana
docker compose restart grafana
curl --fail http://localhost:3200/ready
```

Readiness can take a few seconds after startup. Open [Grafana Explore](http://localhost:3001/explore)
and select **Tempo**. Search for service `evalflow-api`, or select the trace-ID query and paste an ID
to inspect its steps. Health checks and metrics scrapes are excluded; use an application route such
as `GET /jobs` to generate traces. Allow a few seconds for export and search visibility.

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

### Application trace export

Rebuild the API/worker and start the tracing services:

```bash
docker compose up --build -d tempo grafana api worker reaper
curl --fail http://localhost:3000/jobs
```

Compose enables OTLP HTTP/protobuf export to `http://tempo:4318/v1/traces`. For host development,
set `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces` in your environment or
server `.env`, then use `pnpm dev:api` / `pnpm dev:worker`. Without this explicit endpoint, tracing
is disabled. `OTEL_SDK_DISABLED=true` also disables it; ordinary tests force tracing off, while
the tracing integration tests explicitly enable a local mock receiver. No LLM key is needed.

The `startApi.ts` and `startWorker.ts` entrypoints initialize the SDK before dynamically importing
the applications. The start/dev scripts and Compose commands include OpenTelemetry's ES-module
loader hook so HTTP and `pg` can be instrumented before use. Running `src/api.ts` or `src/worker.ts`
directly bypasses SDK initialization. See the official [ES-module setup instructions](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/esm-support.md).

Services are named `evalflow-api` and `evalflow-worker`; `OTEL_SERVICE_NAME` can override the name
for a host process. New root traces are sampled, and an incoming W3C `traceparent` sampling decision
is respected. Fastify adds request/handler spans and Postgres adds query/connection spans under an
active trace. Query parameters/results and request bodies/authorization headers are not explicitly
captured; standard HTTP and SQL query-text metadata are collected by the instrumentation.
`GET /health`, `/livez`, `/readyz` and `/metrics` (including query strings) are excluded. Postgres requires a parent span,
so idle polling and heartbeats outside traced operations do not create standalone traces.
Worker attempts emit `job.process` spans with child spans for the operations described below.

Completed spans are batched in memory and exported about once per second. Export has a one-second
timeout, and shutdown flush is bounded to two seconds and idempotent. A failed export does not fail
a job or change its database status; spans may be lost during outages, queue overflow or process
kills. API SIGTERM/SIGINT drains requests, disconnects Postgres and flushes telemetry within a
ten-second shutdown bound. Worker flushing stays inside its existing shutdown deadlines; the
hard-stop path can still exit before export completes. Prometheus measurements remain unchanged;
OpenTelemetry metrics/log exporters are disabled in this setup.

### Trace context across the job queue

Apply the additive migration before running the updated API/worker. For the Compose stack:

```bash
docker compose up --build -d tempo grafana api worker
```

The existing migration service applies pending migrations before the API/worker/reaper start. Existing
jobs get null context fields and keep their status, attempts, input and results. Host development
also needs the migration applied to its database with `pnpm --filter server exec prisma migrate deploy`.

When a traced API request creates a job, `trace_parent` and `trace_state` store its W3C trace context
alongside the job input. No baggage is persisted. Claims return those fields with the lease.
The worker restores the saved context, records `job.queue_wait` when its timestamps are known, and
creates a new `job.process` child for that consumed attempt. It does not reopen an ended API span.
Postgres work and heartbeats started inside the attempt inherit its context. Each concurrent attempt
uses a separate async context.

```text
API request trace
├── API handler and job insert
├── job.queue_wait (job A, attempt 1)
│   └── job.process (retried)
└── job.queue_wait (job A, attempt 2, including backoff)
    └── job.process (completed)
```

Each attempt span has `job.id`, `job.attempt` and its final `job.outcome`, using the same outcome
definitions as worker metrics. Outcomes are recorded once, after guarded completion/requeue/failure
acceptance where applicable; lease loss and unconfirmed writes remain distinct. Non-completed outcomes
are marked as span errors. Span duration covers the observed attempt, including processing and
finalization. Queue-wait spans measure the preceding queued interval separately.

Automatic worker retries and reaper recovery retain the original context. A manual retry replaces it
atomically with the current retry request's context, so it normally starts a new request trace rather
than appending to the old job trace. An untraced manual retry clears the old context. Dataset runs
create many jobs from one request; those jobs share that request trace and are distinguished by job ID.

Missing or malformed saved context starts a fresh worker trace instead of inheriting another job's
context. Legacy/untraced jobs still execute, and their null context remains null; separate attempts
of such jobs may therefore produce separate root traces. Unsampled context is preserved without
exporting spans. Disabled tracing needs no collector and does not change queue behavior. SIGKILL
cannot end/export an in-progress span, so recovery can appear without its crashed predecessor's
span. Postgres remains the source of truth for accepted job outcomes.

### Full queued time

`job.queue_wait` covers the full interval from the latest queue-entry write to the successful claim,
including intentional retry backoff. It uses persisted Postgres timestamps for both ends rather
than subtracting API/worker clocks. Its attributes are:

| Attribute | Meaning |
| --- | --- |
| `job.queue_wait_ms` | Full queued duration before this attempt's claim. |
| `job.scheduled_delay_ms` | Portion before `run_after`, including intentional retry backoff. |
| `job.ready_wait_ms` | Portion after eligibility while awaiting a claim. |

The last two values add up to the full duration. Eligibility is bounded to the observed interval,
so a fresh job whose `run_after` precedes its insert has zero scheduled delay. A full five-second
wait might consist of two seconds of retry backoff and three seconds eligible for claiming.
The eligible portion includes polling, backlog and claim/database contention; it does not isolate
which cause delayed the claim.

The nullable `queued_at` column gets a database-clock default for new single jobs and dataset jobs.
Worker failure, graceful release, reaper recovery and manual retry refresh it atomically when they
requeue a job. Claiming, completion and exhausted terminal failure preserve the latest entry time.
The migration leaves older rows null rather than assigning invented historical timestamps.
After applying the migration, rebuild/restart the API, worker and reaper together so every requeue
path writes this field:

```bash
docker compose up --build -d tempo grafana api worker reaper
```

The worker creates and immediately ends the retrospective span only after a claim succeeds, using
`queued_at` and the claim's `started_at` as explicit span times. No worker slot or open application
span is needed while the job is queued. The queue-wait span ends at claim time and parents the new
processing span, which starts afterward; this does not add queue time to processing duration or
the existing worker attempt histogram. The timestamps measure write/claim time and can include
transaction visibility/commit delays, rather than recording exact commit instants.

Unknown, malformed or negative intervals produce no queue-wait span, and the worker processes the
job normally. A known zero-length interval produces a real zero-duration span. If the saved trace
context is missing, the queue-wait span can be the root of a new worker trace. If timing is unknown,
processing continues directly from the saved context or a fresh root as before. Unsampled waits
and processing stay unsampled together. Queue spans mark a successful claim; a later processing
failure does not change that wait's status.

Currently queued jobs have no ended queue-wait span yet; use the existing queued-job gauge to see
them. Export remains best effort, so a process kill before export can lose this observation even
though its timestamps persist in Postgres. Automatic retries retain the original trace context
but start a fresh queue interval. Manual retries replace context and also start a fresh interval.

### Pipeline child spans

Each `job.process` attempt creates operation spans under the same trace:

```text
job.process
├── tool.get_user_events
├── tool.get_feature_usage
├── tool.get_subscription_history
├── tool.get_retention_summary
├── prompt.build
├── provider.permit_wait          (when limiting is enabled)
├── llm.call
├── output.parse
├── output.validate
└── evaluation.score
```

The four tools, prompt construction, permit wait and LLM call finish their spans before the subsequent
Postgres detail-trace write. Those writes remain visible as automatic database spans under the attempt.
Database work performed as part of permit acquisition belongs inside the permit span. Disabled mock
limiting skips the permit span entirely. Steps that are never reached produce no spans.

`step.outcome` is `success`, `error`, `cancelled` or `lease_lost`. Fulfilled operations are marked OK;
rejected operations are marked ERROR with `error.type`, and the original error still reaches the
existing retry/fencing logic. These spans do not capture exception messages/stacks or operation
input/output payloads. Existing Postgres detail traces still hold the prompt, model response and
tool payloads, and job errors keep their existing behavior.

An LLM response containing invalid JSON is a successful `llm.call`, then a failed `output.parse`;
schema validation and evaluation are skipped. Valid JSON with the wrong shape fails `output.validate`.
A rejected provider/wrapper call fails `llm.call` and has no later validation spans. Evaluation that
returns a low score is still a successful `evaluation.score` operation: `evalflow.eval.score` and
`evalflow.eval.label_correct` describe quality, while the attempt can complete normally.

The LLM span records `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`,
`gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens`. Gemini maps to `gcp.gemini`; the local
mock uses `mock`. Additional attributes are `evalflow.prompt.version`, `evalflow.usage.total_tokens`,
`evalflow.usage.estimated` and `evalflow.estimated_cost`. Usage/cost values are copied from the
existing pipeline response rather than recalculated; token counts are currently estimates and
the existing cost estimate is currently zero. Calls that reject before returning do not fabricate
usage/cost values. The span name stays `llm.call`, with client kind, and other operation spans use
internal kind. Attribute naming references the official
[GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md).

For inspection, rebuild the API/worker, submit a mock job and select its trace in Grafana Explore.
The span list shows operation durations and status; selecting `llm.call` shows model/usage metadata.
An in-progress call has no exported ended span yet. Shutdown or SIGKILL can still lose unfinished
spans, and an LLM operation may succeed even if the attempt later loses its lease or its result
cannot be persisted.

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
curl http://localhost:3000/livez
curl http://localhost:3000/readyz
```

`/livez` checks HTTP process responsiveness without querying Postgres. `/readyz` returns 503 when
the database probe fails or shutdown has begun; it returns no database error details. The worker
serves the same checks alongside metrics on port 9100, and the reaper on port 9101. Kubernetes uses
readiness to stop Service traffic and liveness to decide restarts. Probe requests are excluded from
API traffic metrics and tracing. See the [kind backend setup](deploy/helm/evalflow-app/README.md).

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

### Kubernetes Worker Autoscaling

A local mock-only demo submits twenty jobs with 12-second model latency. KEDA scales workers from zero
up to four, then back to zero after the jobs complete. Every burst job finishes with one attempt and
one saved evaluation. These captures show actual `kubectl` output with selected columns, formatted
for readability.

**Scale up:** the worker Deployment requests four replicas and all four worker Pods are ready.

![Captured kubectl output showing four ready workers during the mock burst](docs/screenshots/keda-scale-up.png)

**Scale down:** after completion and the idle cooldown, the Deployment requests zero replicas and
no worker Pods remain. KEDA handles zero-to-one and one-to-zero transitions; the HPA handles nonzero
scaling, so the HPA's own minimum of one is expected alongside a ScaledObject minimum of zero.
The Deployment row shows the requested worker count; the HPA can still show its last nonzero recommendation.

![Captured kubectl output showing zero workers after the mock burst drains](docs/screenshots/keda-scale-down.png)

Reproduce after [setting up the local KEDA stack](deploy/helm/evalflow-app/README.md#worker-autoscaling):

```bash
node scripts/kind-keda-check.mjs
```

## Roadmap

- M5 local Kubernetes is implemented: [Postgres](deploy/helm/evalflow/README.md) and the
  [backend application](deploy/helm/evalflow-app/README.md) have separate Helm charts, with migration
  ordering, health checks and live-verified KEDA worker autoscaling. Compose includes the dashboard and monitoring.
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

Pull requests are not currently expected, but small fixes or suggestions are welcome. Contributions should keep the project focused on local backend AI infrastructure, including the planned local Kubernetes milestone, and avoid adding authentication, billing, vector databases, real analytics vendor integrations, or unrelated deployment complexity.

## License

ISC © Alex Peng

### Local worker autoscaling (M5)

Run `bash scripts/kind-keda-up.sh` to install pinned KEDA 2.21.0 and enable workers scaling from
zero to four in the isolated kind cluster. Eligible queued and running jobs count toward a target
of one job per worker; retries still in backoff do not. Run `bash scripts/kind-keda-check.sh` for
the mock-job burst and delayed-retry demo. See the [application chart guide](deploy/helm/evalflow-app/README.md#worker-autoscaling)
for timing controls, watch commands, and switching back to a fixed worker.

### Fixed-worker benchmarks (M6)

The first [benchmark scenario](benchmarks/README.md) compares 1, 2 and 4 fixed workers with one queued
job/second and two-second mock latency. It records queue wait, execution time, end-to-end p50/p99,
completion rates, failures and raw samples. Run `bash scripts/kind-benchmark.sh` against an idle M5
kind stack. KEDA is paused during measurement and restored afterward. This queue/worker benchmark
excludes HTTP submission and real-provider latency; single-run results are exploratory.


The [first captured comparison](docs/benchmarks/2026-10-18-fixed-workers.md) and
[raw job/sample data](docs/benchmarks/2026-10-18-fixed-workers.json) record 60 completed jobs at each
worker count. End-to-end p99 was 62.8s / 3.4s / 2.9s for 1 / 2 / 4 workers, respectively. All three
valid trials had one attempt and one evaluation per job. This is one trial per configuration on a
shared local host; it does not establish maximum capacity or a stable p99.


### Repeated capacity sweep (M6)

`bash scripts/kind-benchmark.sh --sweep` holds four workers fixed and tests 1, 2 and 3 incoming jobs/second
for 60 seconds each, with three rotated repetitions per rate. It saves individual trials and reports
the median/range of each trial's completion rate, p99 latency, sampled queue maximum and drain time.
See the [sweep protocol](benchmarks/README.md#repeated-four-worker-capacity-sweep).


The [captured nine-trial sweep](docs/benchmarks/2026-10-18-capacity-sweep.md) and
[raw data](docs/benchmarks/2026-10-18-capacity-sweep.json) contain 1080 measured jobs, all completed
with one attempt and one evaluation. Medians across the three trials at each arrival rate:

| Arrivals/sec | Completions/sec including drain | Total p99 latency |
| ---: | ---: | ---: |
| 1 | 0.98 | 3.0s |
| 2 | 1.92 | 3.5s |
| 3 | 1.94 | 32.8s |

At three arrivals/sec, the sampled queue peaked at 60–63 jobs and took 32.7–32.9s to drain after arrivals
stopped. Execution p99 stayed near 2.03s. This is consistent with the configured four-worker/two-second
mock workload reaching its processing limit while excess arrivals accumulate. The detailed report
retains all trial values and ranges; three shared-host trials are not a production capacity guarantee.


### Idle polling tradeoff (M6)

The [six-trial comparison](docs/benchmarks/2026-10-18-idle-polling.md) and
[raw data](docs/benchmarks/2026-10-18-idle-polling.json) hold one worker fixed, use zero configured mock
delay, and send the same 30 sparse arrivals per trial. All 180 measured jobs completed once with one
evaluation. Medians of three trial-level metrics per interval:

| Idle poll interval | Queue-wait p99 | Empty claim queries/sec |
| ---: | ---: | ---: |
| 1000ms | 972ms | 0.98 |
| 100ms | 108ms | 9.47 |

Shorter polling reduced idle queue waiting while increasing empty queries by about 9.7 times.
Execution p99 stayed near 21ms; these light-load results measure waking an idle worker, not maximum
throughput. The counter excludes health/producer SQL and measures query frequency, not database CPU
or monetary cost. Three local trials of 30 jobs each provide limited p99 evidence; all trial values
and ranges remain in the report. This does not establish an optimal production interval.

Run `bash scripts/kind-polling-check.sh` for checks, a fresh instrumented image and smoke/full trials,
or see the [protocol](benchmarks/README.md#idle-polling-comparison) for an already deployed image.
The original 1000ms setting and KEDA controls are restored after measurement. The same-build
LISTEN/NOTIFY comparison below adds fresh polling controls rather than reusing this older-image baseline.


### Polling versus notifications on the same build (M6)

The [nine-trial comparison](docs/benchmarks/2026-10-18-wakeup-comparison.md) and
[raw evidence](docs/benchmarks/2026-10-18-wakeup-comparison.json) use the same migrated backend image
for all three conditions: one warm worker/concurrency1, zero configured mock delay, identical sparse
arrivals and three rotated repetitions per condition. All 270 measured jobs completed once with one
evaluation. Medians of the three trial-level metrics:

| Wakeup mode | Queue-wait p99 | Empty claim queries/sec |
| --- | ---: | ---: |
| Poll every 1000 ms | 952ms | 0.98 |
| Poll every 100 ms | 103ms | 9.47 |
| Notifications + 1000 ms backup | 12ms | 1.22 |

Notification trial queue-wait p99 ranged from 7.71–20.65 ms, versus 911.42–965.62 ms for 1000 ms polling and
102.84–106.13 ms for 100 ms polling. Total p99 medians were 967.49/119.71/28.71 ms respectively; execution
p99 medians remained 19–25 ms. This supports faster idle-worker pickup in this local workload. It does
not establish maximum capacity, scale-from-zero latency or a stable production p99.

Notifications used fewer empty claim queries than 100 ms polling, while retaining backup queries and
one extra listener connection per worker process. The counter excludes other SQL and notification/
trigger overhead, so it does not measure total database CPU or cost. All notification trials registered
once before warmup with no observed disconnect/re-registration. Original mode/interval/KEDA settings
were restored; polling remains the default. Detailed trials, ranges, source hashes and migration/image
identity remain in the evidence. Earlier archives are preserved.

Run `bash scripts/kind-wakeup-check.sh` for checks, a fresh kind image/migration, smoke and full trials.
See the [comparison protocol](benchmarks/README.md#same-build-polling-versus-notification-comparison)
for individual modes and cleanup details.
