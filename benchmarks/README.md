# Fixed-worker queue benchmark

First M6 scenario: one job per second, a deterministic 2000ms mock LLM delay, worker concurrency 1,
and fixed worker counts 1, 2, 4. Each trial submits 60 jobs, waits for them to finish, and starts the next
trial with an empty queue. This is one exploratory trial per count, not a repeatable capacity claim.

## Run

The M5 kind cluster/application must already be running. This harness uses only its private kubeconfig
and `kind-evalflow` context, namespace `evalflow`; it does not touch the Compose database.
Use Node 22+, kubectl, an idle queue and the existing mock-only worker settings. Do not submit other jobs
or modify the cluster during the run.

```bash
pnpm test:benchmark
bash scripts/kind-benchmark.sh --jobs 4  # short smoke check; not benchmark evidence
bash scripts/kind-benchmark.sh           # 60 jobs per worker count, roughly five minutes
```

`bash scripts/kind-benchmark.sh --verify` runs the smoke check followed by the default comparison.
The wrapper runs report unit tests first and uses macOS `caffeinate -i` while each trial runs
to prevent idle sleep. Keep the host awake manually on other platforms; closing the lid or force-sleeping
can still invalidate a trial. The local benchmark itself is not run in hosted CI; its
report tests are. The baseline and capacity sweep need no provider key, new dependency, image build, schema change or API change.
The idle-polling comparison below needs the worker claim-counter instrumentation in its image.

## What is measured

The existing `/jobs` API accepts a user ID but does not expose per-job mock latency. A producer runs
inside the existing API Pod and inserts jobs directly into the normal Postgres queue. It copies the
same retention-v1 case snapshots/labels in sorted round-robin order, records the case ID and sets the
same seeded mock configuration. The normal worker still claims, executes and evaluates every job.
This measures queue/worker behavior; it excludes HTTP submission latency and real-provider behavior.

Before each trial, the harness pauses KEDA using `autoscaling.keda.sh/paused-replicas`, waits until the
HPA is removed and the exact requested number of worker Pods is ready, then runs a warmup batch of
one job per worker slot. Cold startup/warmup jobs are excluded from measurements. If KEDA is absent,
it scales the fixed Deployment directly and refuses a competing HPA.

Arrivals are scheduled independently on a monotonic clock at offsets 0, 1, …, 59 seconds. The producer
does not wait for a previous job to finish or a previous submission to be acknowledged before scheduling
the next. Submission scheduling lag and acknowledgement times are saved; over 250ms scheduling lag
invalidates the trial. Thus slower workers cannot silently reduce the offered load.

Every measured job uses maxAttempts 1. This is a no-fault baseline: failures, retries, missing jobs,
duplicate/missing evaluations, backwards/missing timestamps, worker count/readiness changes, Pod
replacement/restarts, sampling failures and database/monotonic clock divergence over one second
invalidate the trial instead of disappearing from results. Clock gaps can indicate suspension or a
clock adjustment; the report does not assume a cause.
Valid JSON with an incorrect prediction is still a completed execution, as in the application.

The JSON report keeps per-job database timestamps, status/attempt/eval counts, every submission and
sampled queue counts. Metrics use the database's clock:

- Total latency: `completed_at - created_at`, including queue time.
- Queue wait: `started_at - created_at` for this single-attempt baseline.
- Execution: `completed_at - started_at`, including tools, mock call, validation and preceding trace writes.
  The completion timestamp is set inside finalization, before the final job/eval writes and commit;
  these timestamp-based metrics do not include that final transaction tail. Reads see committed results.
- Completion rate during arrivals: successful completions by the end of the 60-second window / 60s.
- Completion rate including drain: successful completions / time from the database start marker to
  the final terminal job. It includes queue drain and the initial wait before the first claim.
- Drain: time beyond the arrival window until the final terminal job.
- p50/p99: linear interpolation over successful jobs, with sample count retained. Unknown latency is
  null, never a fabricated zero. Failure/pending/missing counts remain visible separately.
- Peak queue length: maximum observed in roughly one-second samples, not an exact maximum.

One job/second cannot establish a four-worker maximum capacity near two jobs/second. It can show
whether that offered load queues, and how latency differs. In particular, one worker is overloaded,
two are near their ideal limit before overhead, and four have spare theoretical capacity.

## Results and restoration

Results and a fixture-ID manifest are saved under `.evalflow-kind/benchmarks/<UTC timestamp>/`:
`report.json`, `report.md`, `manifest.json`. Git ignores this directory. Environment metadata includes
worker image/resources, node capacity, poll interval, mock/trace settings and source hashes. Save a
reviewed result to `docs/benchmarks/` when ready to share it; do not commit local cluster credentials.

Each successful trial writes its report before deleting only its own terminal measured/warmup jobs.
Failed trials retain jobs for inspection and leave IDs in the manifest. No table truncation is used.
The fixture dataset is loaded idempotently and remains available. Normal success/failure restores the
previous KEDA pause annotation (or the original fixed replica count). An interrupt requests finishing
the bounded current trial before restoring scaling; SIGKILL/power loss cannot run cleanup.
A local `.evalflow-kind/benchmark.lock` prevents overlapping benchmark runs. After a forced kill, inspect
its PID, manifest and queue before removing a stale lock or resuming load. If KEDA remains paused,
restore the original annotation from the manifest; do not blindly remove an owner-supplied pause.

The Docker host is shared with other services; these are local exploratory results. Repeat tests,
vary order/offered rate and control resource contention before publishing stable p99/capacity claims.
The idle-polling experiment below measures the wakeup tradeoff; LISTEN/NOTIFY remains later M6 work.

[KEDA pause controls](https://keda.sh/docs/2.21/concepts/scaling-deployments/#pausing-autoscaling)

## Repeated four-worker capacity sweep

```bash
bash scripts/kind-benchmark.sh --sweep-smoke  # 4-second windows, one trial/rate; validation only
bash scripts/kind-benchmark.sh --sweep        # 60-second windows, three trials/rate
```

`--verify-sweep` runs both in sequence. The full sweep keeps four workers/concurrency1 and the same
2000ms mock latency, then tests 1, 2 and 3 arrivals/second. Every trial has 60 seconds of arrivals, so it
submits 60, 120 or 180 jobs respectively; nine trials contain 1080 measured jobs in total. The order is
1/2/3, 2/3/1, 3/1/2 to balance each rate's position. Each trial starts with an idle queue, runs a warmup
batch, and fully drains before the next. No extra workload is submitted to an overloaded trial after
its 60-second arrival window.

The report retains every trial and gives the median/minimum/maximum of each trial-level metric by
rate. In particular, the reported median p99 is the median of three independently computed trial
p99 values; it is not a percentile of pooled jobs. Aggregates remain unavailable until all three
planned trials for a rate are present and valid. Mixed durations, worker counts or duplicate
repetition IDs cannot produce comparable aggregates. Smoke JSON is explicitly marked with `plan.smoke=true`; its report shows four-second windows
and one trial per rate. It is kept separate from the full experiment.

The one- and two-arrival/s cases bracket the spare/near-capacity regions; three arrivals/s overloads
the ideal four-worker/two-second capacity. A plateau near two completions/s with a growing queue at
three arrivals/s is evidence for this configured mock workload, not a measurement of maximum Postgres
throughput or real LLM capacity. Three repetitions expose a small local range, not a confidence interval.

The first fixed-worker result is preserved unchanged. Its original producer is archived in
`docs/benchmarks/sources/2026-10-18-fixed-workers-produce.mjs`, matching that report's producer hash;
the current producer additionally accepts the sweep rates. The report calculation module remains
compatible with the original evidence.

## Idle polling comparison

```bash
bash scripts/kind-polling-check.sh            # typecheck, tests, fresh kind image/deploy, smoke and full comparison
bash scripts/kind-benchmark.sh --polling-smoke # existing instrumented image: 4 jobs/interval, validation only
bash scripts/kind-benchmark.sh --polling       # existing instrumented image: 30 jobs/interval, three repetitions
```

`--verify-polling` runs smoke and full comparisons together. The check bundle uses macOS idle-sleep
prevention around tests/build/deploy as well as measurement. It leaves the freshly built instrumentation
image deployed. No schema change or real-provider request is needed.

Hold one worker/concurrency1 fixed, with zero configured mock delay and the existing permit limiter
and trace export disabled. Compare `POLL_INTERVAL_MS=1000` and `100`. The worker sleeps only after an
empty/error claim, so this measures waking an idle worker rather than throttling busy processing.
Each trial receives 30 independently scheduled jobs at reproducible seeded gaps of 1500–2499ms,
followed by a 1500ms observation tail: a 62.479-second window. All trials use identical arrival offsets.
The interval order is 1000/100, 100/1000, 1000/100 (three paired repetitions). Each condition starts
with warmup, and the report rejects overlapping job execution/arrivals so queue backlog cannot silently
replace the intended idle-worker scenario. Zero mock delay still leaves normal pipeline/persistence work.

The harness changes the Deployment environment before each trial, waits for rollout and old Pods to
terminate, then monitors the exact ready worker throughout measurement. It restores the original poll
environment entry and KEDA pause setting independently in cleanup, recording restoration success.
Deployment changes are outside the measured window. Forced process termination still cannot run cleanup;
the manifest records original settings for recovery.

The worker exposes `evalflow_worker_claim_queries_total{outcome="claimed|empty|error"}` on its metrics
endpoint. The API-Pod producer snapshots this counter after warmup and at the end of the observation
window. Deltas count measured claim operations, with the rate divided by the actual monotonic time
between snapshots. Every successful empty claim is one queue query returning no job. Other SQL,
including producer inserts, sampling and readiness checks, is excluded. Errors may happen before or
after a query reaches Postgres; any error, counter reset or mismatched claimed-job count invalidates
the trial. This counter measures query frequency, not database CPU, resource saturation or monetary cost.

Reports keep all six trials and summarize median/min/max of each interval's trial-level queue p50/p99,
total/execution p99 and empty/all claim rates. Three repeats expose a small local range; 30 jobs per
trial cannot establish a stable population p99. A shorter poll can reduce idle queue waiting while
increasing empty queries; these results alone do not choose a production setting or demonstrate the
benefit of LISTEN/NOTIFY. The original 1000ms kind setting is restored after the experiment.


The current benchmark harness requires `WORKER_WAKEUP_MODE=poll` (an absent setting means poll for
older images). It refuses notification-enabled workers so a wakeup cannot silently change the polling
baseline. The comparison below reruns all modes on the same migrated/instrumented
build; the notification trigger adds work on queue writes even when workers use polling-only mode.
Existing archived evidence describes its original builds and remains unchanged.


## Same-build polling versus notification comparison

```bash
bash scripts/kind-wakeup-check.sh            # typecheck/report tests, fresh image + kind migration, smoke/full trials
bash scripts/kind-benchmark.sh --wakeup-smoke # existing updated deployment: 4 jobs per condition; validation only
bash scripts/kind-benchmark.sh --wakeup       # existing updated deployment: 30 jobs per condition, 3 repetitions
```

`--verify-wakeup` runs smoke then full comparison. This mode uses the same image and enabled queued-job
trigger for all conditions: `poll-1000`, `poll-100`, `notify-1000` (notifications plus fixed1000ms backup).
The check script builds/deploys the already committed worker feature through the normal Helm migration
workflow and keeps that updated image/trigger installed. No worker runtime or database schema changes
are introduced by this benchmark implementation. It does not deploy to Compose or call a real provider.
The earlier polling-only modes continue to refuse notification-enabled workers; `--wakeup` explicitly
manages both settings instead.

One warm worker/concurrency1, zero configured mock delay, identical seeded1500–2499ms arrival gaps and
the same62.479-second observation window isolate existing idle-worker pickup. Each full trial submits30
jobs, with three repetitions per condition (270 measured jobs plus9 warmups). Order rotates A/B/C,
B/C/A, C/A/B, where A=poll1000, B=poll100 and C=notify1000. Smoke has4 jobs/condition and one repetition.
KEDA is paused and Pod startup/warmup occur outside measurements, so scale-from-zero behavior is excluded.

Before running, the harness verifies the installed notification migration checksum and enabled trigger.
It waits for each mode/interval rollout, exact ready replica count and old-Pod termination. Notification
trials require exactly one `listening` log event before warmup and no disconnect/re-registration through
the trial; polling trials require no listener events. Only those timestamped state events are saved.
A silent network failure without a driver event cannot be ruled out by this log check alone. The existing
Pod UID/readiness/restart, job attempt/eval, clock, counter and arrival-overlap checks remain enforced.
The image ID, migration identity/checksum and worker/listener/producer/harness/report source hashes are
saved with raw per-job/submission/sample data. Comparing the original older-build polling archive directly
against this run would confound mode changes with deployment/migration changes, so controls are rerun.

The report groups by **mode and interval**, preserving individual trials and median/min/max of trial
metrics. Incomplete/invalid groups have no aggregate results. Claim counters measure empty/all claim
operations per actual observation second, excluding warmup and health/producer/other SQL. They do not
measure total database work, trigger cost, notification traffic or listener connection overhead.
Notification mode still makes backup queries and uses one extra connection/process. Do not infer a
query-cost or CPU reduction from lower queue latency alone. Thirty jobs per trial and three local
repetitions provide limited p99 evidence rather than a production latency guarantee.

Normal completion/failure restores both original worker environment entries (including absence) and
KEDA pause settings independently, writing restoration flags in the report. The manifest records all
original entries and fixture IDs. Own valid terminal fixtures are cleaned; invalid trials remain for
inspection. Forced kill/host loss cannot run cleanup; follow the lock/manifest guidance above.
