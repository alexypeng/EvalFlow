import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { checkDatabaseConnection, prisma } from "./db.js";
import { createJob, getJobCounts, getJobDetails, getMetrics, listJobs, retryJob } from "./jobs.js";
import { compareRuns, createRun, getRunBaseline, getRunReport, listRuns } from "./runs.js";
import { listDatasets } from "./datasets.js";
import { CreateJobSchema, CreateRunSchema, ListJobsSchema } from "./types.js";
import { z } from "zod";
import { installApiMetrics } from "./apiMetrics.js";
import { installApiTelemetry, shutdownTelemetry } from "./telemetry.js";

const app = Fastify({
    logger: true,
});

await installApiTelemetry(app);
installApiMetrics(app, getJobCounts);

await app.register(cors, {
    origin: true,
});

app.post("/jobs", async (request, reply) => {
    const parsed = CreateJobSchema.safeParse(request.body);

    if (!parsed.success) {
        return reply.code(400).send({
            error: parsed.error.flatten(),
        });
    }

    const job = await createJob(parsed.data.type, parsed.data.input, parsed.data.maxAttempts ?? 3);

    return reply.code(201).send(job);
});

app.get("/jobs", async (request, reply) => {
    const parsed = ListJobsSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "Invalid job status filter" });
    return listJobs(parsed.data.status);
});

app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    const details = z.uuid().safeParse(request.params.id).success ? await getJobDetails(request.params.id) : null;

    if (!details) {
        return reply.code(404).send({
            error: "Job not found",
        });
    }

    return details;
});

app.post<{ Params: { id: string } }>("/jobs/:id/retry", async (request, reply) => {
    if (!z.uuid().safeParse(request.params.id).success) {
        return reply.code(404).send({ error: "Job not found" });
    }
    const result = await retryJob(request.params.id);

    if (!result.ok && result.reason === "not_found") {
        return reply.code(404).send({
            error: "Job not found",
        });
    }

    if (!result.ok && result.reason === "not_dead_letter") {
        return reply.code(409).send({
            error: "Only dead-lettered jobs can be retried",
            status: result.job.status,
        });
    }

    return result.job;
});

app.get("/datasets", async () => listDatasets());

app.get("/runs", async (request, reply) => {
    const parsed = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "limit must be an integer from 1 to 100" });
    return listRuns(parsed.data.limit);
});

app.post("/runs", async (request, reply) => {
    const parsed = CreateRunSchema.safeParse(request.body);

    if (!parsed.success) {
        return reply.code(400).send({
            error: parsed.error.flatten(),
        });
    }

    const result = await createRun(parsed.data);

    if (!result.ok && result.reason === "dataset_not_found") {
        return reply.code(404).send({
            error: "Dataset not found",
        });
    }

    if (!result.ok && result.reason === "unknown_prompt_version") {
        return reply.code(400).send({
            error: "Unknown prompt version",
        });
    }

    if (!result.ok && result.reason === "mock_config_requires_mock") {
        return reply.code(400).send({ error: "mockConfig requires the mock provider" });
    }

    return reply.code(201).send(result);
});

app.get<{ Params: { id: string } }>("/runs/:id", async (request, reply) => {
    // Not a UUID can't be a run; checking here avoids a Postgres cast error (500).
    const report = z.uuid().safeParse(request.params.id).success ? await getRunReport(request.params.id) : null;

    if (!report) {
        return reply.code(404).send({
            error: "Run not found",
        });
    }

    return report;
});

app.get<{ Params: { baselineId: string; candidateId: string } }>(
    "/runs/:baselineId/compare/:candidateId",
    async (request, reply) => {
        const { baselineId, candidateId } = request.params;
        const validIds = z.uuid().safeParse(baselineId).success && z.uuid().safeParse(candidateId).success;
        const result = validIds ? await compareRuns(baselineId, candidateId) : null;

        if (result?.ok) {
            return result.comparison;
        }

        if (result?.reason === "different_datasets") {
            return reply.code(400).send({
                error: "Runs are of different datasets and cannot be compared",
            });
        }

        return reply.code(404).send({
            error: "Run not found",
        });
    },
);

app.get<{ Params: { id: string } }>("/runs/:id/baseline", async (request, reply) => {
    if (!z.uuid().safeParse(request.params.id).success) {
        return reply.code(404).send({ error: "Run not found" });
    }
    const result = await getRunBaseline(request.params.id);
    if (result.ok) return result.baseline;
    if (result.reason === "run_not_found") return reply.code(404).send({ error: "Run not found" });
    return reply.code(409).send({ error: "Baseline export requires a finished run with all case results" });
});

app.get("/stats", async () => {
    return getMetrics();
});

app.get("/health", async () => {
    const db = await checkDatabaseConnection();

    return {
        ok: true,
        dbTime: db.now,
    };
});

const port = Number(process.env.PORT ?? 3000);

let stopping = false;
function requestShutdown() {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 10000);
    void (async () => {
        try {
            await app.close();
            await prisma.$disconnect();
            await shutdownTelemetry();
        } catch (error) {
            app.log.error(error, "API shutdown failed");
            process.exit(1);
        } finally {
            clearTimeout(timeout);
        }
    })();
}
process.on("SIGTERM", requestShutdown);
process.on("SIGINT", requestShutdown);

await app.listen({
    port,
    host: "0.0.0.0",
});
