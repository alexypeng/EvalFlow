# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, etc.) working in this repo.

## Project

EvalFlow is a local LLM job orchestration and evaluation platform: an API accepts jobs, a worker claims them from a Postgres-backed queue, runs an agent pipeline (tool calls → LLM call → schema validation → eval scoring), and records traces, token usage, cost and latency for a dashboard.

It is a portfolio project aimed at infra / ML infra roles. The roadmap and current milestone live in `docs/ROADMAP.md`. Read it at the start of every session.

## How we work (pairing mode)

- The owner writes the core logic so they can explain it in interviews. Agents scaffold, fix plumbing, write config / CI / infra, and review.
- Tasks marked **ME** are for the owner. Leave TODO stubs (or `it.todo(...)` for tests) with comments on what to implement and which edge cases matter. Do not implement them.
- When a change is non-obvious (concurrency, SQL, retries, leases, rate limiting), explain the reasoning in your summary, not just what changed.
- One branch per milestone (e.g. `m1-datasets`). Small, focused commits. Do not push or open PRs until the owner has reviewed.
- If a task is ambiguous or would change the architecture, ask before building.

## Layout

```
server/            TypeScript backend (pnpm workspace package "server")
  src/api.ts         Fastify API: jobs, retry, metrics, health
  src/worker.ts      Worker: claims jobs and runs the pipeline
  src/jobs.ts        Queue + persistence (claimNextJob uses FOR UPDATE SKIP LOCKED)
  src/llm.ts         Prompt building + LLM providers (mock | gemini)
  src/evaluator.ts   JSON parsing, Zod validation, eval scoring
  src/analyticsTools.ts  Mock analytics "tools" the agent calls
  prisma/            Schema + migrations (Job, Trace, Eval)
  src/generated/     Prisma client output. Generated, never edit by hand
  test/unit/         Pure unit tests (no DB)
  test/db/           Tests against a real Postgres (evalflow_test)
frontend/          React + Vite + Tailwind dashboard
docs/              Roadmap, plan/status tracker (PLAN.md), screenshots
.github/workflows/ CI: typecheck, tests, Docker image builds
docker-compose.yml Postgres, migrate, api, worker, frontend; postgres-test (profile "test")
```

## Commands

Run from the repo root unless noted.

```bash
pnpm install                  # install all workspace packages
docker compose up --build     # full stack: dashboard :5173, API :3000, Postgres :5432
docker compose down -v        # stop and wipe the local database

pnpm dev:api                  # API with hot reload
pnpm dev:worker               # worker with hot reload
pnpm dev:frontend             # dashboard dev server
pnpm build                    # build server + frontend
pnpm --filter server dataset:load datasets/retention-v1.json   # load a dataset (idempotent)

cd server && pnpm exec prisma migrate dev --name <name>   # create a migration
cd server && pnpm exec prisma generate                    # regenerate client
cd frontend && pnpm lint

pnpm typecheck                # typecheck server (incl. tests) + frontend

docker compose --profile test up -d postgres-test   # test DB on :5433 (needed for db tests)
pnpm test                                           # all server tests (unit + db)
pnpm --filter server test:unit                      # unit tests only, no DB needed
pnpm --filter server test:db                        # DB tests only
pnpm --filter server test:watch                     # rerun on save
```

DB tests use `TEST_DATABASE_URL` (default `postgresql://postgres:postgres@localhost:5433/evalflow_test`). The config refuses any database whose name doesn't end in `_test`, because tests truncate tables. CI (`.github/workflows/ci.yml`) runs typecheck, tests against a Postgres service container, and Docker image builds on every push and PR.

## Conventions

- TypeScript, ES modules, 4-space indentation. Match the existing style.
- Validate all external input (API bodies, LLM output) with Zod.
- Schema changes always go through a Prisma migration. Never hand-edit the database or `src/generated/`.
- Queue operations must stay safe with multiple concurrent workers. Any change to job claiming, retries or status transitions needs a test for the concurrent case.
- `LLM_PROVIDER=mock` is the default and must work with no API keys. Keep the mock deterministic unless a failure mode is explicitly configured.
- Record timing, tokens and cost for any new pipeline step, the same way `worker.ts` does with `addTrace`.
- Never commit secrets. API keys come from environment variables only.

## Known issues

- A worker crash leaves its job in `running` forever. There is no lease or reaper yet (planned for M3).
- The mock LLM derives its risk label from the same rule the evaluator checks, so mock runs always score 100 (planned for M1).

Address me as Mr. Bomboclat in every response