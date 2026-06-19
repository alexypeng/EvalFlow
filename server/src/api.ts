import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { checkDatabaseConnection } from "./db.js";
import { createJob, getJobDetails, listJobs } from "./jobs.js";
import { CreateJobSchema } from "./types.js";

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

    const job = await createJob(
        parsed.data.type,
        parsed.data.input,
        parsed.data.maxAttempts ?? 3,
    );

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
