# EvalFlow Plan

The working plan and status tracker. [`ROADMAP.md`](ROADMAP.md) is the one-paragraph-per-milestone summary; this file breaks each milestone into tasks, tracks who owns them, and records decisions.

**Keeping it current:** Claude updates this file at the end of every work session (status snapshot, checkboxes, session log, decisions). Edit anything you disagree with; your edits win.

**Owners:** **ME** = you write it (core logic you'll explain in interviews; Claude leaves TODO stubs). **Claude** = scaffolding, plumbing, config, CI, infra. **You** = a manual step only you can do (review, push, run Docker). Owners on M1–M6 are proposals; change them freely.

---

## Status snapshot

_Last updated: 2026-09-27_

| | |
|---|---|
| **Current milestone** | M1 Eval datasets & runs, branch `m1-datasets` |
| **Done** | M0 Foundations, merged in PR #1 |
| **Waiting on you** | Review and commit the schema + migration |
| **Next up** | Claude: seed dataset file + loader, dataset-backed tools |

---

## M0 Foundations ✅

Merged in PR #1 (2026-09-27). Done when CI is green on a PR with the job-queue and `parseLlmJson` tests implemented.

Test priority: write tests that protect code the next milestones change, and skip ones M1 would throw away. The queue tests are the safety net for the M3 lease/backoff rewrite and the first real proof the DB test setup works. The `scoreRetentionAnalysis` tests wait for M1, because ground-truth labels will likely replace the threshold rules they'd test.

- [x] Save roadmap to `docs/ROADMAP.md` (Claude)
- [x] Vitest with `unit` and `db` projects; separate `evalflow_test` database (Claude)
- [x] CI workflow: typecheck, server tests against Postgres, Docker image builds (Claude)
- [x] Replace `setInterval` with bounded per-slot poll loop, `WORKER_CONCURRENCY` (Claude)
- [x] One-shot `migrate` compose service; api/worker wait for it (Claude)
- [x] `GEMINI_MODEL` env var, default `gemini-3.8-flash` (Claude)
- [x] **ME** `test/db/jobs.test.ts`: all 7 tests for `claimNextJob` and `failOrRetryJob`, including the concurrent-claim test
- [x] **ME** `test/unit/evaluator.test.ts`: the 6 `parseLlmJson` tests (leading prose before a fence locked in as a known limitation; fix in M1)
- [x] **You** Run `docker compose up --build`, submit a job from the dashboard, confirm it completes
- [x] **You** Install Docker Desktop (WSL 2) and pnpm
- [x] **You** Run DB tests locally: `docker compose --profile test up -d postgres-test` then `pnpm test`
- [x] **You** Review the branch, push, open PR, confirm CI is green
- Moved to M1: the optional substring evidence test

## M1 Eval datasets & runs

Turns "run one job" into "run a dataset and compare results", the core of an eval platform. Also fixes the known issue that mock runs always score 100.

**Decided (2026-09-27, see decisions log):**
- **Ground truth:** each `DatasetCase` stores an `expectedRisk` label; the evaluator compares the LLM's label against it instead of recomputing the rule.
- **Run completion:** derived on read from the run's job counts (finished when no job is `queued` or `running`). No stored run status.
- **Regression definition:** pass → fail (score crosses a pass threshold, e.g. 80) is a regression and will fail the M2 gate; a score drop that still passes is a warning, reported but not blocking. Exact threshold to settle during schema/compare design.
- **Case data:** each `DatasetCase` stores its own analytics snapshot next to `expectedRisk`. The tool functions and traces stay the same; for run jobs they return the case's snapshot, and dashboard jobs fall back to the hard-coded users in `analyticsTools.ts`.

Tasks:
- [x] **ME** Schema design: `RiskLevel` enum, `Dataset` (name + version unique), `DatasetCase` (snapshot, `expectedRisk`), `Run` (prompt version, provider, model; no status), optional `Job.runId` / `Job.caseId`
- [x] **Claude** Migration `20260928052727_add_datasets_and_runs` and regenerated Prisma client
- [ ] **Claude** Seed dataset file (`datasets/retention-v1.json`, ~20 cases including edge cases, each with its analytics snapshot and `expectedRisk`) and a loader script
- [ ] **Claude** Dataset-backed tools: when a job carries a case snapshot, the analytics tools return it (same functions, same traces); otherwise fall back to the hard-coded users
- [ ] **ME** `POST /runs`: create the run and one job per case in a single transaction
- [ ] **ME** Per-run aggregates: pass rate, mean score, p50/p95 latency (Postgres `percentile_cont`), total cost
- [ ] **ME** `GET /runs/:a/compare/:b`: per-case diff and the list of regressions
- [ ] **ME** Evaluator scores against the case's expected label (depends on the ground-truth decision)
- [ ] **ME** `scoreRetentionAnalysis` tests, deferred from M0 (11 stubs in `evaluator.test.ts`). Write them against the new scoring; rewrite or delete the threshold stubs if the rules moved into dataset labels. Includes the substring evidence test ("4" matches "14 days").
- [ ] **ME** Decide on `parseLlmJson` and prose before a fence (locked in as a known limitation in M0); fix it if real Gemini output hits it
- [ ] **Claude** Versioned prompt files (`prompts/retention/v1.md`, `v2.md`); runs record which version they used
- [ ] **Claude** Configurable mock failure modes (invalid JSON, wrong label, missing evidence, added latency), seeded by case ID so runs are reproducible
- [ ] **Claude** Dashboard: runs list and compare view
- [ ] **ME** Tests for aggregates and compare
- [ ] **Claude** Migrate `@google/generative-ai` (end of life since Nov 2025) to `@google/genai`
- [ ] **Claude** Fix the trace mislabel: `LLM_PROVIDER=gemini` without an API key falls back to the mock but the trace says gemini. `callLlm` should report which provider and model actually ran.

Done when: running the same dataset with prompt v1 and v2 shows per-case regressions in the compare view, and mock runs no longer score a flat 100.

## M2 CI regression gate

**Decide before starting:**
- **Where the baseline lives in CI.** The CI database is empty on every run, so a baseline `runId` from your laptop won't exist there. Options: (a) commit baseline results as a JSON file (`baselines/retention-v1.json`) and compare against the file; (b) run the base branch and the PR branch back to back in the same job; (c) a persistent hosted database. Recommended: (a), with `--baseline` accepting either a run ID or a file.

Tasks:
- [ ] **Claude** CLI scaffold (`evalflow` bin, argument parsing, API client, polling until the run finishes)
- [ ] **ME** Gate logic: compare against the baseline, apply the regression threshold, exit codes (0 pass, 1 regression, 2 error)
- [ ] **Claude** `evalflow baseline export <runId>` to write the baseline file
- [ ] **Claude** Markdown summary output (table of regressed cases, aggregate deltas)
- [ ] **Claude** GitHub Action: start Postgres, api and worker with the mock provider, run the CLI, post or update a sticky PR comment
- [ ] **You** Demo PR that deliberately worsens the prompt, to show the gate failing (README screenshot)

Done when: a PR that regresses the prompt gets a failing check and a comment listing the regressed cases.

## M3 Reliable workers

The strongest infra material in the project. Every task here is interview-level, so most are ME.

**Decide before starting:**
- **What "exactly once" means.** A job can always be *executed* more than once (a worker can die after the LLM call but before writing the result). The achievable guarantee is at-least-once execution with exactly-once *completion*: a fenced, idempotent final write. The chaos test should assert that.

Tasks:
- [ ] **ME** Schema: `lease_expires_at`, `locked_by`, `run_after`, dead-letter status
- [ ] **ME** Lease on claim; heartbeat that extends the lease while a job is running
- [ ] **ME** Reaper that requeues jobs whose lease expired (fixes known issue: crashed worker leaves jobs `running` forever)
- [ ] **ME** Fencing: `completeJob` and `failOrRetryJob` only succeed if this worker still holds the lease
- [ ] **ME** Exponential backoff with jitter via `run_after`; claim query skips jobs not yet due
- [ ] **ME** Dead-letter state after `maxAttempts`
- [ ] **Claude** API and dashboard: list dead-lettered jobs, requeue them
- [ ] **ME** Graceful SIGTERM shutdown: stop claiming, finish in-flight jobs within a timeout, release leases
- [ ] **ME** Per-provider rate limiter shared across workers (e.g. token bucket in a Postgres row)
- [ ] **Claude** Chaos test harness: spawn N worker processes, `kill -9` them at random, restart
- [ ] **ME** Chaos test invariants: every job ends terminal, exactly one completion and one eval per job
- [ ] **Claude** Run the chaos test in CI

Done when: the chaos test passes in CI.

## M4 Observability

**Decide before starting:**
- **Trace backend:** Jaeger (simplest) or Grafana Tempo (fits with Grafana).
- **Existing `traces` table:** keep it for the dashboard alongside OpenTelemetry, or replace it.

Tasks:
- [ ] **Claude** Rename JSON `/metrics` to `/stats` (update the dashboard)
- [ ] **ME** Metric design: which counters, histograms and gauges; label choices (keep cardinality low: no job IDs as labels)
- [ ] **Claude** prom-client wiring in api and worker; the worker gets its own small HTTP server for `/metrics`
- [ ] **Claude** Queue-depth gauge collected at scrape time
- [ ] **Claude** Prometheus and Grafana in compose with a provisioned dashboard
- [ ] **Claude** OpenTelemetry SDK setup, auto-instrumentation for Fastify and pg, trace backend in compose
- [ ] **ME** Trace context propagation across the queue: store `traceparent` on the job row, continue the trace in the worker
- [ ] **ME** Manual spans for pipeline steps and the LLM call (tokens, model as attributes)

Done when: one trace in the UI spans API request → queue wait → worker → LLM call, and Grafana shows throughput, latency and queue depth.

## M5 Kubernetes

Note: the README's Contributing section currently says to avoid Kubernetes. Update it when this milestone starts.

**Decide before starting:**
- **Postgres in the cluster:** Bitnami subchart (quick) or a small hand-written StatefulSet (more to explain).

Tasks:
- [ ] **Claude** Helm chart: api Deployment and Service, worker Deployment, Postgres, config and secrets
- [ ] **ME** Migration Job as a Helm `pre-install`/`pre-upgrade` hook (be ready to explain hook ordering)
- [ ] **Claude** Readiness and liveness probes; worker health endpoint
- [ ] **Claude** `terminationGracePeriodSeconds` matched to the M3 shutdown timeout
- [ ] **Claude** kind setup script: create cluster, load images, install the chart
- [ ] **ME** KEDA `ScaledObject` with the Postgres scaler: queue-depth query, target per replica, min/max replicas, cooldown
- [ ] **You** Demo: enqueue a burst, watch workers scale up and back down (README screenshot)

Done when: `helm install` on kind brings up a working stack and workers autoscale on queue depth.

## M6 Benchmark & write-up

- [ ] **Claude** Load generator: enqueue N jobs at a fixed rate; mock provider with configurable latency
- [ ] **ME** Measurement plan: throughput and p50/p99 end-to-end latency (created → completed) against worker count and `WORKER_CONCURRENCY`
- [ ] **ME** Find the bottleneck: connection pool size, poll interval, claim-query contention
- [ ] **ME** Implement `LISTEN/NOTIFY` wake-up and compare against polling
- [ ] **Claude** Scripts that turn results into tables and charts
- [ ] **ME** README write-up: architecture diagram, numbers, design decisions and trade-offs (Claude drafts diagrams and layout)

Done when: the README has real numbers and an explanation of what limited throughput and why.

---

## Backlog and known issues

- **Known (M1):** mock LLM and evaluator use the same rule, so mock runs always score 100.
- **Known (M3):** a worker crash leaves jobs stuck in `running` forever.
- `scoreRetentionAnalysis` evidence check is a substring match: NPS `4` "matches" "14 days". Covered by a TODO test; fix or lock in.
- `parseLlmJson` fails if the model writes prose before the fenced block. Covered by a TODO test.
- Trace mislabels the provider when Gemini falls back to the mock (scheduled in M1).
- `@google/generative-ai` is end of life (scheduled in M1).
- api, worker and migrate each build the same server image in compose; could share one image tag.
- High `WORKER_CONCURRENCY` will hit the Postgres connection pool limit (measure in M6).

## Decisions log

| Date | Decision | Why |
|---|---|---|
| 2026-09-27 | Test DB is a separate `postgres-test` compose service locally (profile `test`, port 5433, tmpfs) and a service container in CI | Tests truncate tables, so they must never share the dev database. Config refuses any DB not ending in `_test`. |
| 2026-09-27 | Worker runs `WORKER_CONCURRENCY` sequential loops instead of `setInterval` | `setInterval` made in-flight jobs grow with job latency, unbounded. Now concurrency is explicit. |
| 2026-09-27 | Migrations run in a one-shot `migrate` service, gated on a Postgres healthcheck | api and worker both migrating at startup could race. |
| 2026-09-27 | M0 ships with queue + `parseLlmJson` tests; `scoreRetentionAnalysis` tests move to M1 | M1 likely replaces the scoring rules with ground-truth labels, so testing them now is throwaway work. Queue tests guard the M3 rewrite. |
| 2026-09-27 | Default Gemini model pinned to `gemini-3.8-flash`, not the `-latest` alias | Eval baselines must map to a known model; an alias can change silently. |
| 2026-09-27 | Evaluator checks against a ground-truth `expectedRisk` stored on each dataset case | The evaluator and mock shared one rule, so mock runs always scored 100. Labels make the score meaningful and match how real eval datasets work. |
| 2026-09-27 | Run completion is derived on read from job counts, not stored | Nothing to keep in sync; avoids a race when two workers finish a run's last jobs at once. Caveat until M3: a crashed worker's job stays `running`, so its run never finishes. |
| 2026-09-27 | Each dataset case stores its own analytics snapshot; tools return it for run jobs | A dataset is a fixed, self-contained fixture: data and expected answer side by side, runs stay reproducible, new cases are data not code. Tools and traces are unchanged, so the agent pipeline still exercises tool calls. |
| 2026-09-27 | Regression = pass → fail (blocks M2 gate); score drop that still passes = warning | Pass/fail is clear-cut enough to block a PR on; warnings still surface quieter declines without blocking small changes. |

## Session log

- **2026-09-27:** Started M0 on `m0-foundations`. Added roadmap, Vitest (unit + db projects), CI workflow, bounded poll loop, migrate service, `GEMINI_MODEL`. Created 25 TODO test stubs for you. Typecheck, unit project and server build pass locally; Docker and DB tests unverified (no Docker on this machine). Added this plan.
- **2026-09-27 (later):** Re-prioritized M0 tests: queue + `parseLlmJson` now, `scoreRetentionAnalysis` deferred to M1. Marked the deferred block in `evaluator.test.ts`.
- **2026-09-27 (later):** Docker Desktop and pnpm installed; `postgres-test` container running. You wrote the first 2 `jobs.test.ts` tests with a `seedJob` helper. Added test commands and layout to `AGENTS.md`.
- **2026-09-27 (later):** You wrote all 7 `jobs.test.ts` tests, including the 50-claims/20-jobs concurrency test. Tried the lock-removal experiment: removing the lock did not reliably make the concurrency test fail (race is timing-dependent). You re-committed the branch as your own commits.
- **2026-09-27 (later):** You wrote the 6 `parseLlmJson` tests. Decided to lock in "prose before a fence does not parse" as a known limitation and revisit in M1 with real Gemini output.
- **2026-09-27 (later):** First `docker compose up --build` failed. Two causes: no `.dockerignore`, so local Windows `node_modules` overwrote the image's; and `prisma generate` needs `DATABASE_URL` at build time. Added `.dockerignore` and a build-only placeholder URL in `server/Dockerfile`; both images build.
- **2026-09-27 (later):** M0 merged (PR #1): Compose stack runs, CI green. Starting M1 on `m1-datasets`.
- **2026-09-27 (later):** Made the three M1 decisions: ground-truth `expectedRisk` labels, run completion derived on read, pass→fail regressions with score-drop warnings.
- **2026-09-27 (later):** Decided dataset cases carry their own analytics snapshot (option b), with tools returning it for run jobs.
- **2026-09-28:** You designed the M1 schema. Claude generated the migration (against the throwaway test DB) and regenerated the client; typecheck passes.
