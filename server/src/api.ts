import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { checkDatabaseConnection } from "./db.js";
import { createJob, getJobDetails, getMetrics, listJobs, retryJob } from "./jobs.js";
import { compareRuns, createRun, getRunReport } from "./runs.js";
import { CreateJobSchema, CreateRunSchema } from "./types.js";
import { z } from "zod";

const app = Fastify({
    logger: true,
});

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

app.get("/jobs", async () => {
    return listJobs();
});

app.get<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    const details = await getJobDetails(request.params.id);

    if (!details) {
        return reply.code(404).send({
            error: "Job not found",
        });
    }

    return details;
});

app.post<{ Params: { id: string } }>("/jobs/:id/retry", async (request, reply) => {
    const result = await retryJob(request.params.id);

    if (!result.ok && result.reason === "not_found") {
        return reply.code(404).send({
            error: "Job not found",
        });
    }

    if (!result.ok && result.reason === "not_failed") {
        return reply.code(409).send({
            error: "Only failed jobs can be retried",
            status: result.job.status,
        });
    }

    return result.job;
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

app.get("/metrics", async () => {
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

await app.listen({
    port,
    host: "0.0.0.0",
});
