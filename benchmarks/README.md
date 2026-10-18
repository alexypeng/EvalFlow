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
report tests are. No provider key, new dependency, image build, schema change or API change is needed.

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
Polling versus LISTEN/NOTIFY and bottleneck changes are later M6 work.

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
