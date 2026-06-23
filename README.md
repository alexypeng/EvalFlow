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
Dashboard: http://localhost:5173
API:       http://localhost:3000
Postgres:  localhost:5432
```

Stop the stack with:

```bash
docker compose down
```

Remove local database state if you want a clean reset:

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
LLM_PROVIDER=mock
PORT=3000
```

`LLM_PROVIDER=mock` is the default so the project can run locally without an API key. Use `LLM_PROVIDER=gemini` and set `GEMINI_API_KEY` to call Gemini instead of the mock provider.

`DATABASE_URL` differs depending on where the process runs:

- Inside Docker Compose, services use `postgres` as the database host.
- Outside Docker, local processes use `localhost` as the database host.

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
9. Retry failed jobs until `maxAttempts`, then mark them `failed`.

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
- status: `queued`, `running`, `completed`, `failed`
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
- The worker claims queued jobs with database locking to avoid duplicate processing.
- Attempts are incremented when work is claimed.
- Failed jobs are retried until `maxAttempts`.
- Jobs are marked `failed` after retries are exhausted.
- Failed jobs can be manually retried from the API or dashboard.

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

Retry a failed job:

```bash
curl -X POST http://localhost:3000/jobs/<job_id>/retry
```

Get aggregate metrics:

```bash
curl http://localhost:3000/metrics
```

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
