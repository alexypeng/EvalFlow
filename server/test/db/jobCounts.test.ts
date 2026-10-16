import Fastify from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { getJobCounts, claimNextJob } from "../../src/jobs.js";
import { installApiMetrics } from "../../src/apiMetrics.js";
import { resetDatabase } from "./helpers.js";
import { randomUUID } from "node:crypto";

beforeEach(resetDatabase);

describe("job status counts", () => {
    it("reports all four zeros for an empty database", async () => {
        expect(await getJobCounts()).toEqual({ queued: 0, running: 0, completed: 0, dead_letter: 0 });
    });

    it("counts all stored jobs, including delayed and run-associated jobs beyond the list limit", async () => {
        const run = await prisma.run.create({
            data: {
                dataset: { create: { name: "counts", version: 1 } },
                promptVersion: "v1", provider: "mock", model: "mock",
            },
        });
        await prisma.job.createMany({
            data: [
                ...Array.from({ length: 105 }, () => ({ type: "test", input: {}, status: "queued" as const })),
                {
                    type: "test", input: {}, status: "queued", runId: run.id,
                    runAfter: new Date(Date.now() + 86_400_000), attempts: 1,
                },
                { type: "test", input: {}, status: "running" },
                { type: "test", input: {}, status: "completed" },
                { type: "test", input: {}, status: "dead_letter" },
            ],
        });
        expect(await getJobCounts()).toEqual({ queued: 106, running: 1, completed: 1, dead_letter: 1 });
    });

    it("serves fresh counts as jobs are claimed concurrently and when the queue empties", async () => {
        await prisma.job.createMany({ data: Array.from({ length: 8 }, () => ({ type: "test", input: {} })) });
        const app = Fastify();
        installApiMetrics(app, getJobCounts);
        try {
            expect((await app.inject("/metrics")).body).toContain('evalflow_jobs{status="queued"} 8');
            const claims = await Promise.all(Array.from({ length: 8 }, () => claimNextJob(randomUUID(), 60_000)));
            expect(claims.filter(Boolean)).toHaveLength(8);
            const next = await app.inject("/metrics");
            expect(next.body).toContain('evalflow_jobs{status="queued"} 0');
            expect(next.body).toContain('evalflow_jobs{status="running"} 8');
            await resetDatabase();
            const empty = await app.inject("/metrics");
            for (const status of ["queued", "running", "completed", "dead_letter"]) {
                expect(empty.body).toContain(`evalflow_jobs{status="${status}"} 0`);
            }
        } finally {
            await app.close();
        }
    });
});
