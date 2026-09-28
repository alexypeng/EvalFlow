import { describe, it, expect, beforeEach } from "vitest";
import { resetDatabase } from "./helpers.js";
import { prisma } from "../../src/db.js";
import { claimNextJob, failOrRetryJob } from "../../src/jobs.js";
import { Prisma } from "../../src/generated/prisma/client.js";

beforeEach(resetDatabase);

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

        const claimed = await claimNextJob();

        expect(claimed!.id).toBe(job1.id);
        expect(claimed!.status).toBe("running");
        expect(claimed!.attempts).toBe(job1.attempts + 1);
        expect(claimed!.startedAt).toBeInstanceOf(Date);
    });

    it("returns null when nothing is queued", async () => {
        await seedJob({ status: "running" });
        await seedJob({ status: "completed" });
        await seedJob({ status: "failed" });
        const claimed = await claimNextJob();
        expect(claimed).toBeNull();
    });

    it("ignores jobs that are not queued", async () => {
        await seedJob({ status: "running", createdAt: secondsAgo(3) });
        const job = await seedJob({ createdAt: secondsAgo(1) });

        const claimed = await claimNextJob();
        expect(claimed!.id).toBe(job.id);
    });

    it("never returns the same job to two concurrent claims", async () => {
        for (let i = 0; i < 20; i++) {
            await seedJob();
        }

        const results = await Promise.all(Array.from({ length: 50 }, () => claimNextJob()));
        const claimed = results.filter((job) => job !== null);
        expect(claimed).toHaveLength(20);

        const jobIds = claimed.map((job) => job.id);
        const ids = new Set(jobIds);
        expect(ids.size).toBe(20);

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
        const job = await seedJob({ status: "running", attempts: 1, maxAttempts: 3 });

        const retry = await failOrRetryJob({
            id: job.id,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            error: "LLM returned invalid JSON",
        });

        expect(retry.status).toBe("queued");
        expect(retry.error).toBe("LLM returned invalid JSON");
        expect(retry.completedAt).toBeNull();
        expect(retry.attempts).toBe(1);
    });

    it("marks the job failed once attempts reach maxAttempts", async () => {
        await seedJob({ maxAttempts: 3 });
        for (let i = 0; i < 3; i++) {
            const run = await claimNextJob();
            const failed = await failOrRetryJob({
                id: run!.id,
                attempts: run!.attempts,
                maxAttempts: run!.maxAttempts,
                error: "LLM returned invalid JSON",
            });
            if (i === 2) {
                expect(failed.status).toBe("failed");
                expect(failed.completedAt).toBeInstanceOf(Date);
            } else {
                expect(failed.status).toBe("queued");
            }
        }

        const claimed = await claimNextJob();

        expect(claimed).toBeNull();
    });

    it("records the most recent error message", async () => {
        await seedJob();

        let claimed = await claimNextJob();
        await failOrRetryJob({
            id: claimed!.id,
            attempts: claimed!.attempts,
            maxAttempts: claimed!.maxAttempts,
            error: "timeout",
        });

        claimed = await claimNextJob();
        const failed = await failOrRetryJob({
            id: claimed!.id,
            attempts: claimed!.attempts,
            maxAttempts: claimed!.maxAttempts,
            error: "LLM returned invalid JSON",
        });

        expect(failed.error).toBe("LLM returned invalid JSON");
    });
});
