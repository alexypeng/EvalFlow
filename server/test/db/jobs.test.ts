import { describe, it, expect, beforeEach } from "vitest";
import { resetDatabase } from "./helpers.js";
import { prisma } from "../../src/db.js";
import { claimNextJob, failOrRetryJob } from "../../src/jobs.js";
import { Prisma } from "../../src/generated/prisma/client.js";

// TODO(ME): implement these. They run against the real test Postgres
// (see vitest.config.ts), because the interesting behavior lives in SQL
// (FOR UPDATE SKIP LOCKED), which a mock can't reproduce.
//
// Setup:
//   - import { resetDatabase } from "./helpers.js" and call it in beforeEach
//   - import { prisma } from "../../src/db.js" to seed/inspect rows
//   - import { claimNextJob, createJob, failOrRetryJob } from "../../src/jobs.js"
//
// createdAt defaults to now(), so jobs created back-to-back can share a
// timestamp. When order matters, seed with prisma.job.create and set
// createdAt explicitly.

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
    // Seed 3 queued jobs with increasing createdAt. Claim once; expect the
    // oldest. Also assert the returned row has status "running",
    // attempts incremented by 1, and startedAt set.
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

    // Seed jobs in running/completed/failed states only. Expect null.
    it("returns null when nothing is queued", async () => {
        await seedJob({ status: "running" });
        await seedJob({ status: "completed" });
        await seedJob({ status: "failed" });
        const claimed = await claimNextJob();
        expect(claimed).toBeNull();
    });

    // Only status 'queued' is eligible. A running job that's older than a
    // queued one must be skipped.
    it("ignores jobs that are not queued", async () => {
        await seedJob({ status: "running", createdAt: secondsAgo(3) });
        const job = await seedJob({ createdAt: secondsAgo(1) });

        const claimed = await claimNextJob();
        expect(claimed!.id).toBe(job.id);
    });

    // The core concurrency guarantee. Seed N queued jobs (say 20), then fire
    // many claims at once: await Promise.all(Array.from({length: 50}, claimNextJob)).
    // Expect: exactly N non-null results, all ids distinct, and every job in
    // the DB is now 'running' with attempts === 1.
    //
    // Note: Promise.all only gives real concurrency if the pg pool has more
    // than one connection (it does by default). Be ready to explain why
    // SKIP LOCKED makes this safe, and what would break without it
    // (hint: remove SKIP LOCKED and think about what the second transaction
    // sees after the first commits).
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
    // Job with attempts=1, maxAttempts=3. Call failOrRetryJob. Expect status
    // back to 'queued', error saved, completedAt null.
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

    // Drive a job through the full loop: claim -> failOrRetry, repeated.
    // With maxAttempts=3, after the 3rd claim+fail it should be 'failed'
    // with completedAt set, and a 4th claimNextJob should return null.
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

    // The error message from the latest attempt is what's stored.
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
