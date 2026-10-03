# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, Cursor, etc.) working in this repo.

## Project

EvalFlow is a local LLM job orchestration and evaluation platform: an API accepts jobs, a worker claims them from a Postgres-backed queue, runs an agent pipeline (tool calls → LLM call → schema validation → eval scoring), and records traces, token usage, cost and latency for a dashboard.

It is a portfolio project aimed at infra / ML infra roles. At the start of every session, read `docs/ROADMAP.md` (milestones M0–M6) and `docs/PLAN.md` (task breakdown, owners, current status, decisions log).

## How we work (pairing mode)

- The owner is the engineer in charge: they make the design decisions and oversee the code. Agents write the code, including core logic and tests (changed 2026-10-03; tasks still marked **ME** in `docs/PLAN.md` mean "owner must understand and approve", not "owner types it").
- **Plan together first.** Before building anything non-trivial, agree the approach with the owner. Present real design choices as questions; don't decide them silently.
- **Explain everything you build**, including scaffolding, plumbing, config, CI and infra, not only core logic: what it is, why it's needed, and how it fits. Keep explanations simple and concrete.
- **Grill the owner after writing.** After each piece of work, explain it, then quiz the owner with a few questions (why it's built this way, what breaks if X changes, edge cases, how they'd explain it in an interview). Wait for their answers, correct misunderstandings, and don't move on to the next piece until they can explain it. Questions should get harder as they improve.
- When a change is non-obvious (concurrency, SQL, retries, leases, rate limiting), explain the reasoning in your summary, not just what changed.
- One branch per milestone (e.g. `m1-datasets`).
- **Never commit, push or open PRs.** The owner makes every commit. Leave changes uncommitted, list the files you changed, and suggest commit commands and messages. Don't run history-changing git commands (commit, amend, reset, rebase) unless the owner asks for that specific action.
- **Keep `docs/PLAN.md` current.** At the end of each work session, update the status snapshot, task checkboxes, decisions log (with the reasoning) and add a session log entry. Leave it uncommitted with the rest of the changes.
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
  prompts/retention/ Versioned prompt templates (v1.md, v2.md); {{userId}} and {{snapshot}} placeholders
  datasets/          Dataset fixture files for dataset:load
  prisma/            Schema + migrations (Job, Trace, Eval, Dataset, DatasetCase, Run)
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

- TypeScript, ES modules, 4-space indentation, 120-column lines (Prettier: `--tab-width 4 --print-width 120`). Match the existing style.
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