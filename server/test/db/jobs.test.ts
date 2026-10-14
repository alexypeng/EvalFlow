import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeEach } from "vitest";
import { makeJobDue, resetDatabase } from "./helpers.js";
import { prisma } from "../../src/db.js";
import { claimNextJob, failOrRetryJob } from "../../src/jobs.js";
import { Prisma } from "../../src/generated/prisma/client.js";

beforeEach(resetDatabase);
const workerId = randomUUID();
const claim = () => claimNextJob(workerId, 60_000);

function seedJob(overrides: Partial<Prisma.JobCreateInput> = {}) {
    return prisma.job.create({
        data: {
            type: "retention_risk_analysis",
            input: { userId: "user_test" },
            ...overrides,
        },
    });
}

function secondsAgo(seconds: number) {
    return new Date(Date.now() - seconds * 1000);
}

describe("claimNextJob", () => {
    it("claims the oldest queued job", async () => {
        const job1 = await seedJob({ createdAt: secondsAgo(3) });
        await seedJob({ createdAt: secondsAgo(2) });
        await seedJob({ createdAt: secondsAgo(1) });

        const claimed = await claim();

        expect(claimed!.id).toBe(job1.id);
        expect(claimed!.status).toBe("running");
        expect(claimed!.attempts).toBe(job1.attempts + 1);
        expect(claimed!.startedAt).toBeInstanceOf(Date);
    });

    it("returns null when nothing is queued", async () => {
        await seedJob({ status: "running" });
        await seedJob({ status: "completed" });
        await seedJob({ status: "dead_letter" });
        const claimed = await claim();
        expect(claimed).toBeNull();
    });

    it("ignores jobs that are not queued", async () => {
        await seedJob({ status: "running", createdAt: secondsAgo(3) });
        const job = await seedJob({ createdAt: secondsAgo(1) });

        const claimed = await claim();
        expect(claimed!.id).toBe(job.id);
    });

    it("never returns the same job to two concurrent claims", async () => {
        for (let i = 0; i < 20; i++) {
            await seedJob();
        }

        const results = await Promise.all(Array.from({ length: 50 }, () => claimNextJob(randomUUID(), 60_000)));
        const claimed = results.filter((job) => job !== null);
        expect(claimed).toHaveLength(20);

        const jobIds = claimed.map((job) => job.id);
        const ids = new Set(jobIds);
        expect(ids.size).toBe(20);
        expect(new Set(claimed.map((job) => job.leaseToken)).size).toBe(20);
        expect(new Set(claimed.map((job) => job.lockedBy)).size).toBe(20);

        const allJobs = await prisma.job.findMany();
        expect(allJobs).toHaveLength(20);
        for (const job of allJobs) {
            expect(job.status).toBe("running");
            expect(job.attempts).toBe(1);
        }
    });
});

describe("failOrRetryJob", () => {
    it("requeues when attempts < maxAttempts", async () => {
        await seedJob({ maxAttempts: 3 });
        const job = (await claim())!;

        const retry = await failOrRetryJob({
            ...job,
            error: "LLM returned invalid JSON",
        });

        expect(retry!.status).toBe("queued");
        expect(retry!.error).toBe("LLM returned invalid JSON");
        expect(retry!.completedAt).toBeNull();
        expect(retry!.attempts).toBe(1);
    });

    it("marks the job failed once attempts reach maxAttempts", async () => {
        await seedJob({ maxAttempts: 3 });
        for (let i = 0; i < 3; i++) {
            const run = await claim();
            const failed = await failOrRetryJob({
                ...run!,
                error: "LLM returned invalid JSON",
            });
            if (i === 2) {
                expect(failed!.status).toBe("dead_letter");
                expect(failed!.completedAt).toBeInstanceOf(Date);
            } else {
                expect(failed!.status).toBe("queued");
                expect(await claim()).toBeNull();
                await makeJobDue(run!.id);
            }
        }

        const claimed = await claim();

        expect(claimed).toBeNull();
    });

    it("records the most recent error message", async () => {
        await seedJob();

        let claimed = await claim();
        await failOrRetryJob({
            ...claimed!,
            error: "timeout",
        });

        await makeJobDue(claimed!.id);
        claimed = await claim();
        const failed = await failOrRetryJob({
            ...claimed!,
            error: "LLM returned invalid JSON",
        });

        expect(failed!.error).toBe("LLM returned invalid JSON");
    });
});
