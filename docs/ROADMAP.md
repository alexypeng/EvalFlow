# EvalFlow Roadmap

Goal: grow EvalFlow into an infra / ML-infra portfolio project.

Task-level breakdown, owners, status and decisions: [`PLAN.md`](PLAN.md).

## Milestones

- **M0 Foundations:** Vitest, GitHub Actions CI, fix worker poll loop, run migrations once, make Gemini model configurable.
- **M1 Eval datasets & runs:** Dataset / DatasetCase / Run tables, jobs get `runId`; `POST /runs` fans out one job per case; per-run aggregates (pass rate, mean score, p50/p95 latency, cost); `GET /runs/:a/compare/:b` for per-case regressions; versioned prompt files; configurable mock failure modes; dashboard runs list + compare view.
- **M2 CI regression gate:** `evalflow run --dataset X --baseline <runId>` CLI that exits nonzero on regression; GitHub Action runs it on PRs with the mock provider and posts a summary comment.
- **M3 Reliable workers:** leases + heartbeats + reaper for crashed jobs, exponential backoff with jitter (`run_after`), dead-letter state, graceful SIGTERM shutdown, shared per-provider rate limiter, chaos test that kills workers randomly and asserts every job ends exactly once.
- **M4 Observability:** prom-client `/metrics` (rename current JSON `/metrics` to `/stats`), Grafana dashboard in compose, OpenTelemetry traces API → queue → worker → LLM.
- **M5 Kubernetes:** Helm chart (api, worker, postgres, migration Job), kind locally, KEDA Postgres scaler for worker autoscaling.
- **M6 Benchmark & write-up:** load test throughput vs worker count and p99, find the bottleneck (pool size, polling vs LISTEN/NOTIFY), README with architecture diagram and numbers.

## Known issues

- A worker crash leaves jobs stuck in `running` forever (fix in M3).
- The mock LLM uses the same rule as the evaluator, so mock runs always score 100 (fix in M1).
