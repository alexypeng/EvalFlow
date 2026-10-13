# EvalFlow Plan

The working plan and status tracker. [`ROADMAP.md`](ROADMAP.md) is the one-paragraph-per-milestone summary; this file breaks each milestone into tasks, tracks who owns them, and records decisions.

**Keeping it current:** Claude updates this file at the end of every work session (status snapshot, checkboxes, session log, decisions). Edit anything you disagree with; your edits win.

**How we work (since 2026-10-03):** we plan together; Claude writes the code; Claude then grills you until you can explain it; you commit. **ME** = core logic you must be able to explain in interviews (you decide the design and get quizzed on it). **Claude** = scaffolding, plumbing, config, CI, infra. **You** = a manual step only you can do (review, push, run Docker).

---

## Status snapshot

_Last updated: 2026-10-13_

| | |
|---|---|
| **Current milestone** | M2 CI regression gate, branch `m2-ci-gate` |
| **Done** | M0 Foundations (PR #1), M1 datasets and runs (PR #2), both merged |
| **Waiting on you** | Baseline export learning review; export changes are uncommitted |
| **Next up** | After review, implement regression gate logic using committed JSON baselines |

**Auth learning task (2026-10-07):** Requested with VibeWise. Initial inspection complete;
awaiting the owner's access/ownership reasoning before choosing a design. No auth code changed.

**Implementation refresh (2026-10-12):** Comparison learning review completed. Owner chose
per-run mock settings. Implemented validated failure rates, seed and latency, saved on each run
and copied into its jobs. Reports and comparisons expose the saved configuration. Full suite:
100 passed, 1 expected failure; typecheck passes. The mock still ignores prompt content when
selecting labels, so different prompt versions alone do not demonstrate label regressions.
Owner approved the dashboard scope and it is implemented: run/dataset lists, run creation,
report details and comparison filters. Full suite now passes 105 tests plus 1 expected failure;
typecheck, frontend lint and builds pass. Browser QA covered empty states, creating v1/v2 runs,
finished metrics, baseline/candidate selection, improvement filtering and a 400-pixel comparison
layout. Gemini SDK migration is now implemented and verified (109 passed, 1 expected failure;
typecheck and server build pass), committed by the owner, with learning review completed. Parser
inspection confirmed that prose before a fence is rejected. No Gemini API key is available in
the server environment at first inspection; the owner then configured it locally. A small live
SDK request returned plain JSON, but dataset prompt sampling timed out and then returned 503.
On retry, the clear-high dataset case with v1 returned plain JSON that passed schema validation
and matched its answer key; v2 returned 503. No leading-prose failure observed in the successful
sample. Further v2 diagnosis returned valid plain JSON matching the answer key in 5.6 seconds.
A follow-up through the actual callLlm wrapper returned 503 with Google's explicit high-demand
message. v2 can produce valid output; provider availability is intermittent. Parser unchanged.
Auth scope is unresolved.

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
- [x] **Claude** Seed dataset `server/datasets/retention-v1.json` (20 cases: 16 follow the threshold rule incl. boundaries, 4 `judgment_*` cases where the rule is wrong) and loader `pnpm --filter server dataset:load <file>` (Zod-validated; immutable: same version reloads are no-ops, changed content errors)
- [x] **ME** Review the 4 `judgment_*` labels; they are the cases the mock (rule-based) should get wrong. Approved as-is 2026-09-28.
- [x] **Claude** Dataset-backed tools: `job.input.snapshot` (validated by `JobInputSchema`) is returned by the same tool functions; traces record `source: dataset_case | built_in_mock`
- [x] **ME** `POST /runs`: create the run and one job per case in a single transaction. Each job's `input` carries the case's `userId`, `snapshot`, `promptVersion` and `expectedRisk` (decided 2026-09-28: copy, don't look up). Add a test that the built prompt never contains the label.
- [x] **ME** Per-run aggregates: implemented `getRunReport` and `GET /runs/:id`, with pass rate, mean score, p50/p95 latency (Postgres `percentile_cont`), total tokens and cost; 8 report tests implemented.
- [x] **ME** `GET /runs/:a/compare/:b`: implemented `compareRuns`, per-case outcomes and regression/improvement/warning/pending classification; route `GET /runs/:baselineId/compare/:candidateId` (404 unknown, 400 different datasets), with 9 comparison tests.
- [x] **ME** Evaluator scores against the case's expected label (depends on the ground-truth decision)
- [x] **ME** `scoreRetentionAnalysis` tests, deferred from M0 (11 stubs in `evaluator.test.ts`). Write them against the new scoring; rewrite or delete the threshold stubs if the rules moved into dataset labels. Includes the substring evidence test ("4" matches "14 days").
- [x] **ME** Decide on `parseLlmJson` and prose before a fence: retain current parser after sampled v1/v2 responses parsed successfully; leading-prose limitation stays documented. Owner chose to follow milestone order; provider retry improvements remain M3.
- [x] **Claude** Versioned prompt files (`server/prompts/retention/v1.md`, `v2.md`); jobs carry `input.promptVersion` (default `v1`) and the `llm_call` trace records it. `POST /runs` should validate the version with `PromptVersionSchema`, store it on the run, and copy it into each job's `input`.
- [x] **Claude** Configurable mock failure modes (invalid JSON, wrong label, missing evidence, added latency), seeded by case ID so runs are reproducible. Per-run `mockConfig` is saved and copied into jobs; learning review completed.
- [x] **Claude** Dashboard: runs list and compare view, with dataset selection, run creation, saved mock settings, report details and comparison filters; dashboard learning review completed.
- [x] **ME** Tests for aggregates and compare
- [x] **Claude** Migrate `@google/generative-ai` to `@google/genai`; learning review completed, live v1/v2 SDK responses verified. Provider overload remains intermittent; full worker path not live-verified.
- [x] **Claude** Fix the trace mislabel: `callLlm` now returns the `provider` and `model` that actually ran, and the trace uses them. `resolveLlm()` gives the same answer up front, for `POST /runs` to fill `Run.provider` / `Run.model`.

Done when: running the same dataset with prompt v1 and v2 shows per-case regressions in the compare view, and mock runs no longer score a flat 100.

## M2 CI regression gate

**Decide before starting:**
- **Where the baseline lives in CI.** The CI database is empty on every run, so a baseline `runId` from your laptop won't exist there. Options: (a) commit baseline results as a JSON file (`baselines/retention-v1.json`) and compare against the file; (b) run the base branch and the PR branch back to back in the same job; (c) a persistent hosted database. Recommended: (a), with `--baseline` accepting either a run ID or a file.

**Decided (2026-10-12):** Owner approved committed JSON baseline results. File format and export/gate
implementation come after the CLI scaffold review. Cases in exported files must use stable identifiers across
fresh CI databases; local database case UUIDs alone cannot identify them.

Tasks:
- [x] **Claude** CLI scaffold (`evalflow` bin, argument parsing, API client, polling until the run finishes); committed and learning review completed. Reports only for this piece; baseline/gate commands follow.
- [ ] **ME** Gate logic: compare against the baseline, apply the regression threshold, exit codes (0 pass, 1 regression, 2 error)
- [x] **Claude** `evalflow baseline export <runId>` to write the baseline file; learning review pending. Validated format v1, finished runs only, stdout or non-overwriting --output file.
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

- [ ] **ME** Auth: decide access/ownership scope, agree design and implementation scope, then implement with VibeWise.
- **Known (M1):** ground-truth grading is implemented, so mock runs can lose points on judgment cases; the mock still ignores prompt content when selecting labels, so v1/v2 alone do not demonstrate label regressions.
- **Known (M3):** a worker crash leaves jobs stuck in `running` forever.
- `scoreRetentionAnalysis` evidence check is a substring match: NPS `4` "matches" "14 days". Documented by an `it.fails` test; fixing it flips that test.
- `parseLlmJson` fails if the model writes prose before the fenced block. Covered by a TODO test.
- Gemini now uses `@google/genai`; token counts remain character-based estimates and cost remains zero.
- api, worker and migrate each build the same server image in compose; could share one image tag.
- High `WORKER_CONCURRENCY` will hit the Postgres connection pool limit (measure in M6).

## Decisions log

| Date | Decision | Why |
|---|---|---|
| 2026-10-13 | Owner approved baseline format with dataset name/version, saved run configuration and case-name keyed terminal outcomes/scores; formatVersion=1 | Case names survive fresh databases, unlike UUIDs. Saved configuration explains the results; latest eval semantics match reports/comparisons. Pending/missing cases cannot establish a baseline. |
| 2026-10-13 | Export uses read-only GET /runs/:id/baseline, validates strict JSON, and writes new files with exclusive creation | Export creates no jobs and exposes no snapshots or answer keys. Duplicate names, pending outcomes and malformed values are rejected. Existing baseline files cannot be overwritten accidentally. Native compiled CLI preserves exact exit codes; pnpm may remap errors to 1. |
| 2026-10-12 | Owner approved committed JSON baselines for M2 | CI starts with a fresh database, so a laptop run ID is unavailable. A versioned file keeps expected results reviewable without persistent hosting. |
| 2026-10-12 | CLI scaffold creates a run once, polls sequentially with a total deadline, and separates report stdout from progress stderr | Prevents duplicate run creation after ambiguous failures, avoids overlapping polls and unbounded CI waits, and supports machine-readable output. Exit 0 currently means report retrieved; regression exit codes belong to the next gate piece. |
| 2026-10-12 | Follow milestone order; retain current parser and leave delayed provider retries in M3 | Sampled v1/v2 responses were valid JSON; observed failures were intermittent provider overload. No parser defect was demonstrated by these samples. M2 baseline strategy is the next design decision. |
| 2026-10-12 | Owner approved Gemini SDK migration; switched to `GoogleGenAI.models.generateContent` while retaining model configuration, prompts, estimated tokens and zero cost | Limits this piece to the SDK replacement. Missing response text becomes an empty string rejected by the existing JSON validation path; provider errors still propagate for worker retries. Actual usage metadata and parser changes remain separate work. |
| 2026-10-12 | Owner approved dataset/run listing APIs, run creation with prompt/mock settings, progress/results, and baseline/candidate comparison | Completes the visible dataset evaluation workflow while retaining the Single job view for traces and retry. |
| 2026-10-12 | Run list defaults to the newest 50 (validated maximum 100), with one batched aggregate query over the selected runs and a latest-eval lateral join | Avoids invoking the multi-query individual report for every list row. One eval per job prevents retries from inflating pass counts; metrics and pass rules match individual reports. |
| 2026-10-12 | Dashboard polls after requests finish, cancels obsolete requests and restricts candidates to the baseline's dataset ID | Slow requests do not accumulate overlapping polls. Selection changes cannot apply an old response to a new pair. Dataset ID includes version, so each comparison uses the same questions and answer key. |
| 2026-10-12 | Owner chose per-run mock settings rather than worker environment settings | Baseline and candidate can use different settings without restarting workers; saved settings make results explainable and repeatable. |
| 2026-10-12 | Implementation uses independent seed/case-ID/mode hashes for failure rates, with zero failures by default; settings are copied into jobs in the run transaction | Selection stays stable across retries and worker ordering. Independent mode hashes prevent one setting from shifting another mode's selection. Case IDs must remain the same for reproduction; a fresh database can select different cases. Missing evidence remains a schema failure, and label perturbation never reads ground truth. |
| 2026-09-27 | Test DB is a separate `postgres-test` compose service locally (profile `test`, port 5433, tmpfs) and a service container in CI | Tests truncate tables, so they must never share the dev database. Config refuses any DB not ending in `_test`. |
| 2026-09-27 | Worker runs `WORKER_CONCURRENCY` sequential loops instead of `setInterval` | `setInterval` made in-flight jobs grow with job latency, unbounded. Now concurrency is explicit. |
| 2026-09-27 | Migrations run in a one-shot `migrate` service, gated on a Postgres healthcheck | api and worker both migrating at startup could race. |
| 2026-09-27 | M0 ships with queue + `parseLlmJson` tests; `scoreRetentionAnalysis` tests move to M1 | M1 likely replaces the scoring rules with ground-truth labels, so testing them now is throwaway work. Queue tests guard the M3 rewrite. |
| 2026-09-27 | Default Gemini model pinned to `gemini-3.8-flash`, not the `-latest` alias | Eval baselines must map to a known model; an alias can change silently. |
| 2026-09-27 | Evaluator checks against a ground-truth `expectedRisk` stored on each dataset case | The evaluator and mock shared one rule, so mock runs always scored 100. Labels make the score meaningful and match how real eval datasets work. |
| 2026-09-27 | Run completion is derived on read from job counts, not stored | Nothing to keep in sync; avoids a race when two workers finish a run's last jobs at once. Caveat until M3: a crashed worker's job stays `running`, so its run never finishes. |
| 2026-09-27 | Each dataset case stores its own analytics snapshot; tools return it for run jobs | A dataset is a fixed, self-contained fixture: data and expected answer side by side, runs stay reproducible, new cases are data not code. Tools and traces are unchanged, so the agent pipeline still exercises tool calls. |
| 2026-09-27 | Regression = pass → fail (blocks M2 gate); score drop that still passes = warning | Pass/fail is clear-cut enough to block a PR on; warnings still surface quieter declines without blocking small changes. |
| 2026-09-28 | Prompt version travels in `job.input.promptVersion`, like the snapshot; validated as `v<N>` | The worker needs no extra lookup and dashboard jobs keep working (default `v1`). The pattern stops the version from being used as a file path. Same shape as the open `expectedRisk` question, so pick one approach for both. |
| 2026-09-28 | `POST /runs` copies each case's `expectedRisk` into `job.input` (optional in `JobInputSchema`); the evaluator reads it from there and falls back to the threshold rule for dashboard jobs | Same pattern as `snapshot` and `promptVersion`: jobs are self-contained and the worker never queries dataset tables. Datasets are immutable, so the copy can't go stale. The label never reaches the prompt (`buildRetentionPrompt` only takes userId + snapshot); a test should lock that in. Lookup via `caseId` would only win if labels could change after a run or job inputs were exposed somewhere the answer mustn't be seen. |
| 2026-09-28 | Traces and runs record the provider/model that actually ran (`resolveLlm()`), not `LLM_PROVIDER` | Gemini without a key falls back to the mock; recording the env var would label mock results as gemini and poison run comparisons. |
| 2026-10-01 | Code is formatted with Prettier at 4-space indent, 120 columns (was 80) | Matches the owner's editor settings, so saving a file no longer reformats untouched lines and bloats diffs. One-off reformat of all hand-written TS/TSX; `src/generated/` excluded. |
| 2026-10-01 | A case passes when its job completed and its risk label matches the answer key; failed jobs don't pass. Pass rate = passed / all cases | A score threshold (e.g. >= 80) lets a wrong label pass: the mock scores 80 on the 4 judgment cases, so it would show 100% despite 4 wrong answers. The label is the task; format/evidence quality shows in mean score. |
| 2026-10-03 | New working agreement: plan together, Claude writes all code, Claude quizzes you after each piece, you commit | Faster than typing everything, while the quizzing keeps you able to explain every part in interviews. |

## Session log

- **2026-10-13 (baseline export):** Owner approved the proposed format. Added BaselineSchema/type (format v1, dataset/configuration, unique case names, terminal outcomes, nullable failed scores), getRunBaseline reusing latest-eval sides, and read-only GET /runs/:id/baseline (404 unknown, 409 unfinished/missing). Added CLI baseline export with UUID/options validation, request deadline, stdout JSON and exclusive --output file creation. Added six DB tests and ten CLI unit cases, including portability after DB reload, latest evals, terminal failures, Gemini metadata, invalid files and overwrite refusal. Corrected a typo in the new DB test during verification. Typecheck/server build and full suite pass (140 passed, 1 existing expected failure). Live mock test-DB QA verified 404/409, finished 20-case export with 16 passes, clean JSON stdout and unchanged file after overwrite refusal. pnpm remaps child error code 2 to 1; verified exact codes through the compiled entry and documented it. Temporary API/worker stopped; QA artifact only under /private/tmp. No production DB or Gemini calls; no commits, pushes or PRs. Gate/CI remain pending; export learning review next.
- **2026-10-12 (CLI learning review and baseline planning):** Confirmed M1 merged as PR #2. Owner explained that a CLI timeout must not cancel durable jobs, identified that exit 0 only means a finished report was retrieved, and reviewed why repeating creation after a lost response can create duplicate runs. Clarified failed outcomes versus passing cases with weaker scores. CLI review completed. Proposed baseline export containing dataset name/version, run configuration and case-name keyed terminal outcomes/scores; export rejects unfinished runs. Case names are portable across databases unlike UUIDs. Awaiting agreement before implementing export. Only PLAN changed; no tests or commits.
- **2026-10-12 (M2 CLI scaffold):** Owner approved committed JSON baselines. Created m2-ci-gate branch (Git reference writes required sandbox escalation), carrying the uncommitted PLAN update. Added evalflow binary/development command, Node built-in argument parsing, Zod input/response validation, one-shot run creation, sequential report polling, total timeout, progress stderr and JSON stdout. Added 15 unit cases covering terminal failures, malformed arguments/responses, API errors, no creation retries and stalled polling. Typecheck/server build and unit tests pass (80 passed, 1 expected failure). Live mock smoke checks used only evalflow_test: both prompt versions completed 20 cases with 16 passes; child-process verification confirmed stdout is valid JSON. Temporary API/worker stopped after verification. No production DB or Gemini requests. Updated README; gate/export remain unimplemented pending scaffold review. No commits, pushes or PRs; existing untracked learning files preserved.
- **2026-10-12 (return to milestone plan):** Owner chose to follow the existing plan rather than move retry work forward. Closed the M1 parser decision with the current behavior retained and leading-prose limitation documented; successful samples do not guarantee all future outputs. Delayed retries remain M3. Read roadmap/plan and identified M2's required first choice: committed JSON baseline, base/PR runs in one CI job, or persistent DB. Recommended the plan's committed JSON option; awaiting owner choice before implementation. Only PLAN changed; no tests, branch changes, commits, pushes or PRs.
- **2026-10-12 (v2 availability diagnosis):** Owner requested diagnosing v2 before moving on. Used diagnosing-bugs skill and the existing temporary live feedback loop; no CONTEXT/ADR files found by scoped filename search. Unchanged v2 prompt/case succeeded through the SDK (plain JSON, valid schema, correct high label, 5626 ms). Follow-up through production callLlm returned 503 after 706 ms with the explicit message that the model is experiencing high demand. This is an intermittent provider failure; no deterministic prompt defect or parser failure reproduced, so no prompt/parser fix or synthetic regression test added. Read Google's troubleshooting guidance and inspected queue retry path: failed attempts requeue immediately, with no run_after backoff. Proposed agreeing whether to bring that M3 work forward; no queue/schema changes made. Only PLAN updated; temporary diagnostics remain in /private/tmp, all processes ended. No commits, pushes or PRs.
- **2026-10-12 (two-call dataset retry):** Owner authorized one real dataset case with both prompt versions. Used clear_high_all_signals with existing prompt templates and unchanged parser/schema, through the new SDK with a temporary three-minute request limit and SDK retries disabled. v1 returned plain JSON, parsed successfully, passed schema validation and matched expectedRisk=high. v2 returned provider status 503. No leading-prose issue observed; one successful sample does not guarantee future output format. Parser unchanged; recommendation is to retain its current contract and document the limitation, pending owner agreement. Raw successful response retained only under /private/tmp/evalflow-gemini-parser-results.json. No application changes or additional tests; updated PLAN only. No commits, pushes or PRs.
- **2026-10-12 (live Gemini parser check):** Owner configured GEMINI_API_KEY locally; checked presence without printing it. Prepared temporary scripts under /private/tmp using existing prompts, dataset cases and parser. Initial production-wrapper request did not return and was stopped. A bounded SDK dataset request timed out (504); a minimal JSON diagnostic succeeded with plain JSON. Retried dataset sampling with a longer limit and SDK retries disabled; provider returned 503 on the first case. No v1/v2 dataset response available, so no evidence yet that real prompts hit the leading-prose limitation. Parser unchanged; M1 parser decision remains open. Temporary processes finished/stopped; no key or env file changes by the agent, no commits. Only PLAN changed in the repo; no tests needed for that documentation update.
- **2026-10-12 (parser preparation and SDK learning review):** Owner correctly explained that empty text retries because it fails validation, while a valid wrong answer completes with failed evaluation. SDK review completed; working tree confirms migration was committed. Owner approved checking real Gemini output. Read prompts/parser/tests and checked only configuration presence (no secrets printed): server environment has no Gemini API key and resolves to mock. Real-output sampling awaits the owner setting GEMINI_API_KEY locally; no live requests or parser changes made. Existing leading-prose rejection test remains. No additional tests or commits.
- **2026-10-12 (Gemini SDK migration):** Owner approved the migration. Replaced the legacy dependency with `@google/genai` 2.28.0 and updated the Gemini call/response format using Google's official migration guide. Added four unit tests for prompt/model forwarding and accounting, empty responses, provider errors and mock isolation. Verified typecheck, server build and full suite (109 passed, 1 expected failure); DB tests required sandbox escalation to access local test Postgres. Updated README with the existing token/cost limitations. No live Gemini request made; parser unchanged. Migration learning review pending. No commits, pushes or PRs.
- **2026-10-12 (dashboard learning review):** Reviewed why comparisons require the same cases and answer keys, why only the latest evaluation counts for each job, and how overlapping polls can return out of order and overwrite newer progress. Owner identified the stale-response problem; explained polling as repeated read-only requests scheduled two seconds after completion. Dashboard review completed. Proposed planning the Gemini SDK migration next, then revisiting JSON parsing with real provider output. No application code changes or additional tests; no commits, pushes or PRs.
- **2026-10-12 (runs dashboard):** Owner approved the proposed scope. Added GET /datasets with case counts and GET /runs with bounded newest-first reports using batched SQL aggregates. Added Dataset runs / Single job navigation, run creation with optional mock settings, run table, report details, compatible baseline/candidate selection, per-case filters, visible pending/error states and responsive styles. Added 5 DB tests for list/report consistency, latest evals, mixed statuses, limits, empty results and dataset versions. Verified typecheck, frontend lint, server/frontend builds and full suite (105 passed, 1 expected failure). HTTP smoke checks covered list routes and invalid limits. Browser-created v1/v2 runs finished with 16 regressions, 2 improvements and 2 unchanged cases; verified comparison selection/filtering and the 400-pixel layout, with no console runtime errors observed. Used the Sites skill's local-only workflow; no hosting or publication. QA used only the dedicated test DB. Temporary QA servers stopped afterward. Updated README and the stale roadmap mock issue. No commits, pushes or PRs; pre-existing learning files preserved. Dashboard quiz pending.
- **2026-10-12 (mock-settings learning review):** Owner identified changing environment settings as a reproducibility risk, explained that changing seed/case ID can hide a previously selected failure, and identified invalid JSON as a retry trigger. Clarified that valid JSON with a wrong label completes execution but fails evaluation; retries are for execution/validation failures. Learning checkpoint completed. No application changes or additional tests; dashboard scope remains to be agreed.
- **2026-10-12 (per-run mock settings):** Owner approved per-run configuration. Added Zod validation/defaults, a Prisma-generated `Run.mockConfig` migration and regenerated client, transactional run/job settings, claimed case ID, worker trace settings, deterministic mock failures and latency. Added unit validation/determinism/provider tests, persistence tests and a real-worker DB test covering retries, failures, latency and 16 demonstrated regressions. Documented the API and limitations in README. Typecheck and full suite pass (100 passed, 1 expected failure); DB suite needed Docker Desktop/test Postgres startup and sandbox escalation. Migration applied only to test DB. Learning quiz pending. No commits, pushes or PRs; existing untracked learning files preserved.
- **2026-10-12 (comparison learning review):** Owner explained why unfinished candidate cases remain pending, identified fail-to-pass as improvement, and identified a score drop with both cases passing as warning. Comparison checkpoint completed. Next design question: configure mock failures per run and persist the configuration, or configure them globally through worker environment variables. No approach confirmed; no application code changed or tests run.
- **2026-10-12 (next-task review):** Read roadmap, plan, learning checkpoints, mock implementation, comparison logic and API routes. Recommended completing the outstanding comparison quiz, then agreeing deterministic mock failure profiles, adding run/dataset listing APIs and the runs/compare dashboard, and finishing Gemini SDK/parser work. Refreshed the stale mock known issue. No application code changed or tests run; existing plan edits and untracked learning files preserved. No new design decisions confirmed.
- **2026-10-07 (VibeWise planning):** Reviewed remaining M1 tasks against the LLM implementation, comparison classifications, worker call sites, and frontend API. Proposed an M1 completion sequence without treating it as a confirmed choice. Recorded the outstanding comparison reasoning question in learning notes. Auth remains unresolved. No application code changed or tests run.
- **2026-10-07 (VibeWise auth):** Inspected API, browser API calls, dashboard flow, and Prisma schema. No auth checks or account/session/ownership models observed. Created `.vibe-wise/` learning notes and recorded the pending Build checkpoint: shared workspace versus private user data and the owner's reasoning. Auth design remains undecided; no implementation or tests run. Existing untracked `LEARNING_CHECKLIST.md` left untouched.
- **2026-10-07 (merge resolution):** Resolved the plan conflict between the local status refresh and remote report/comparison work. Kept the October 7 update date, remote completed task status and next steps, and both session histories. The earlier October 7 entry describes the older local checkout before these remote commits were merged. Verification: typecheck and full suite pass (74 passed, 1 expected failure); full suite required access outside the sandbox to reach local Postgres. Merge left uncommitted.
- **2026-10-07:** Checked the roadmap and current code to identify the next task. `getRunReport` is implemented, but all 7 report tests remain TODOs. Updated the stale status snapshot: next is owner-written report DB tests, followed by per-case comparison. No code changes or tests run.
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
- **2026-09-28:** Claude added the retention-v1 dataset (20 cases), the dataset loader, and dataset-backed tools, with 6 new tests (19 passing). Until the evaluator scores against `expectedRisk` (ME task), mock runs will still score 100.
- **2026-09-28 (later):** Ran `pnpm install` (server dev deps like vitest were missing on this Mac); typecheck and unit tests then passed. Claude added versioned prompts (`server/prompts/retention/v1.md` = the old inline prompt, `v2.md` = weighs subscription/events and context, aimed at the `judgment_*` cases), `input.promptVersion`, `resolveLlm()`, and the provider/model fix, plus `test/unit/llm.test.ts` (8 tests). **Unverified:** the shell stopped accepting commands partway through, so typecheck and tests were not run after these edits.
- **2026-09-28 (later):** You approved the 4 `judgment_*` labels and chose to copy `expectedRisk` into `job.input`. Claude scaffolded `POST /runs`:
  - `RiskLevelSchema` and optional `expectedRisk` in `JobInputSchema`
  - a `CreateRunSchema` stub
  - `server/src/runs.ts` with the `CreateRunResult` contract and a `createRun` TODO(ME)
  - the route in `api.ts` (400 bad body or unknown prompt, 404 unknown dataset, 201 created)
  - `promptVersionExists()` in `llm.ts`
  - 7 `it.todo` stubs in `test/db/runs.test.ts`

  Unverified (shell down).
- **2026-09-28 (later):** Removed unnecessary code comments repo-wide (Prisma/Vite boilerplate, stale test instructions above implemented tests, comments restating code or duplicating the decisions log). Kept only the comments that stop someone from breaking something, plus the TODO(ME) guidance on the open `scoreRetentionAnalysis` stubs. `frontend/src/api.ts` `parseResponseError` rewritten without the empty catch. Also unverified (shell down).
- **2026-09-28 (later, Windows PC):** Verified the Mac sessions' unverified work here: `pnpm typecheck` (server + frontend) and all 16 unit tests pass. The comment cleanup touched only comments in config files. DB tests not run: Docker Desktop wasn't running.
- **2026-09-28 (later, Windows PC):** DB tests verified too: `pnpm test` gives 27 passed, 19 todo (12 deferred scoring stubs + 7 `runs.test.ts` stubs). All Mac-session work is now verified.
- **2026-09-29:** You implemented `createRun` (dataset lookup, prompt check, `resolveLlm`, run + jobs in one `$transaction`) and 3 of its tests. Claude pinned `LLM_PROVIDER=mock` in `vitest.config.ts` so a developer's `.env` can't switch tests to Gemini; verified by running the suite with Gemini env set (30 passed).
- **2026-09-29 (later):** You finished all 7 `runs.test.ts` tests, including transaction rollback (break-it check done: `tx` → `prisma` makes it fail) and the answer-key-never-in-prompt test. `POST /runs` is done.
- **2026-10-01:** You made the evaluator grade run jobs against `expectedRisk` (rule fallback for dashboard jobs; notes name the source) and the worker pass it through. Claude reformatted the codebase to 120 columns; typecheck, lint and unit tests pass, DB tests not run (Docker off).
- **2026-10-01 (later):** Claude wrote the 14 `scoreRetentionAnalysis` tests at your request (helpers `makeSnapshot` / `makeOutput` / `score`; answer-key vs rule-fallback grading, score arithmetic, evidence support, threshold boundaries via `it.each`, notes text). Substring weakness documented with `it.fails`. Break-it check: making the evaluator ignore `expectedRisk` fails the 2 answer-key tests. 39 unit tests pass.
- **2026-10-01 (later):** Decided the pass rule (correct label). Claude scaffolded the run report card: `RunReport` contract, `getRunReport` TODO(ME), `GET /runs/:id` (404 for unknown or non-UUID ids), test helpers and 7 stubs. Also removed a stray `import { snapshot } from "node:test"` from `runs.ts`. Typecheck and unit tests pass; DB tests not run (Docker off).
- **2026-10-02:** You implemented `getRunReport` (groupBy status counts, passes from each completed job's latest eval, aggregate mean/totals, `percentile_cont` p50/p95). Typecheck passes; its 7 tests are next.
- **2026-10-02 (later):** Claude wrote the 8 `getRunReport` tests at your request (unknown run, fresh run, pass rule, mean/totals over completed only, p50/p95 = 1050/1905, finished status, latest eval). Break-it check caught a flawed first version of the latest-eval test (two mirror-image jobs always gave 1 pass), split into two tests that both fail when the oldest eval is read. 65 tests pass.
- **2026-10-02 (later):** Claude scaffolded compare: the contract (a case is pass / fail / pending; a pair is regression / improvement / warning / unchanged / pending, with pending checked first so unfinished cases are never called regressions), the `compareRuns` TODO(ME), the route, and 9 stubs in a new `test/db/compare.test.ts`. Moved `startRun` / `finishJob` into `test/db/helpers.ts` and added `jobForCase`. Typecheck passes; 65 tests pass.
- **2026-10-03:** New working agreement (plan together, Claude writes, Claude quizzes you, you commit). Agreed any score drop on a still-passing case is a warning. Claude implemented `compareRuns` (both runs loaded in parallel, each run's jobs in a Map keyed by caseId, pending checked first, sorted by case name in code) and its 9 tests. Break-it checks: dropping the pending-first rule and treating equal scores as warnings each fail 2 tests. 74 tests pass.
