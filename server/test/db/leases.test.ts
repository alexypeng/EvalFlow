import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { claimNextJob, completeJob, failOrRetryJob, renewJobLease, retryJob } from "../../src/jobs.js";
import type { JobLease, JobEvaluation } from "../../src/jobs.js";
import { makeJobDue, resetDatabase, startRun } from "./helpers.js";

beforeEach(resetDatabase);
const workerId = randomUUID();
const claim = () => claimNextJob(workerId, 60_000);
const evaluation: JobEvaluation = {
    validJson: true, hasRequiredFields: true, evidenceIncluded: true, evidenceSupported: true,
    reasonableRiskLabel: true, taskCompletionScore: 100, notes: "test",
};
const finish = (lease: JobLease, evalResult = evaluation) => completeJob({
    ...lease, result: { riskLabel: "low" }, latencyMs: 50, promptTokens: 10, completionTokens: 20,
    totalTokens: 30, estimatedCost: 0, evaluation: evalResult,
});
async function seed(maxAttempts = 3) {
    return prisma.job.create({ data: { type: "retention_risk_analysis", input: { userId: "user_test" }, maxAttempts } });
}

it("skips future and exhausted jobs without consuming attempts", async () => {
    const future = await seed();
    await prisma.$executeRaw`UPDATE jobs SET run_after = clock_timestamp() + interval '1 hour' WHERE id = ${future.id}::uuid`;
    const exhausted = await seed(1);
    await prisma.job.update({ where: { id: exhausted.id }, data: { attempts: 1 } });
    const due = await seed();
    expect((await claim())!.id).toBe(due.id);
    expect(await claim()).toBeNull();
    expect((await prisma.job.findUniqueOrThrow({ where: { id: future.id } })).attempts).toBe(0);
    await prisma.$executeRaw`UPDATE jobs SET run_after = clock_timestamp() WHERE id = ${future.id}::uuid`;
    expect((await claim())!.id).toBe(future.id);
});

it("persists ownership and extends a live lease using database time", async () => {
    await seed();
    const lease = (await claim())!;
    expect(lease.lockedBy).toBe(workerId);
    expect(lease.leaseToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(await renewJobLease(lease, 120_000)).toBe(true);
    const saved = await prisma.job.findUniqueOrThrow({ where: { id: lease.id } });
    expect(saved.leaseExpiresAt!.getTime()).toBeGreaterThan(lease.leaseExpiresAt.getTime() + 50_000);
    expect(saved.attempts).toBe(1);
});

it("rejects expired leases for renewal, completion and failure without creating evals", async () => {
    await seed();
    const lease = (await claim())!;
    await prisma.$executeRaw`UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${lease.id}::uuid`;
    const before = await prisma.job.findUniqueOrThrow({ where: { id: lease.id } });
    expect(await renewJobLease(lease, 60_000)).toBe(false);
    expect(await finish(lease)).toBeNull();
    expect(await failOrRetryJob({ ...lease, error: "stale failure" })).toBeNull();
    expect(await prisma.job.findUniqueOrThrow({ where: { id: lease.id } })).toEqual(before);
    expect(await prisma.eval.count()).toBe(0);
});

it("rejects a different worker even with the right claim token", async () => {
    await seed();
    const lease = { ...(await claim())!, lockedBy: randomUUID() };
    expect(await renewJobLease(lease, 60_000)).toBe(false);
    expect(await finish(lease)).toBeNull();
    expect(await failOrRetryJob({ ...lease, error: "wrong worker" })).toBeNull();
});

it("issues a new token after manual retry resets attempts, fencing the old claim from the same worker", async () => {
    await seed(1);
    const old = (await claim())!;
    const failed = await failOrRetryJob({ ...old, error: "invalid JSON" });
    expect(failed).toMatchObject({ status: "failed", lockedBy: null, leaseToken: null, leaseExpiresAt: null });
    expect((await retryJob(old.id)).ok).toBe(true);
    const current = (await claim())!;
    expect(current.attempts).toBe(old.attempts);
    expect(current.lockedBy).toBe(old.lockedBy);
    expect(current.leaseToken).not.toBe(old.leaseToken);
    expect(await renewJobLease(old, 60_000)).toBe(false);
    expect(await finish(old)).toBeNull();
    expect(await failOrRetryJob({ ...old, error: "stale" })).toBeNull();
    expect(await finish(current)).toMatchObject({ status: "completed", lockedBy: null, leaseToken: null, leaseExpiresAt: null });
    expect(await prisma.eval.count()).toBe(1);
});

it("accepts only one of concurrent completions and stores exactly one eval", async () => {
    await seed();
    const lease = (await claim())!;
    const results = await Promise.all(Array.from({ length: 10 }, () => finish(lease)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await prisma.eval.count()).toBe(1);
    const completed = await prisma.job.findUniqueOrThrow({ where: { id: lease.id } });
    expect(completed).toMatchObject({ status: "completed", evalScore: 100, totalTokens: 30 });
    expect(await failOrRetryJob({ ...lease, error: "late failure" })).toBeNull();
    expect(await renewJobLease(lease, 60_000)).toBe(false);
    expect(await prisma.job.findUniqueOrThrow({ where: { id: lease.id } })).toEqual(completed);
});

it("serializes completion racing with a retry so only one transition wins", async () => {
    await seed();
    const lease = (await claim())!;
    const results = await Promise.all([finish(lease), failOrRetryJob({ ...lease, error: "failure" })]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const saved = await prisma.job.findUniqueOrThrow({ where: { id: lease.id } });
    expect(await prisma.eval.count()).toBe(saved.status === "completed" ? 1 : 0);
    expect(saved.status).toBe(results[0] ? "completed" : "queued");
    expect(saved.leaseToken).toBeNull();
});

it("rolls back job completion when saving the eval fails", async () => {
    await seed();
    const lease = (await claim())!;
    const before = await prisma.job.findUniqueOrThrow({ where: { id: lease.id } });
    await expect(finish(lease, { ...evaluation, notes: "invalid PostgreSQL text \u0000" })).rejects.toThrow();
    expect(await prisma.job.findUniqueOrThrow({ where: { id: lease.id } })).toEqual(before);
    expect(await prisma.eval.count()).toBe(0);
    expect(await finish(lease)).not.toBeNull();
});

it("accepts only one concurrent manual retry", async () => {
    const job = await seed(1);
    await failOrRetryJob({ ...(await claim())!, error: "failed" });
    const results = await Promise.all(Array.from({ length: 10 }, () => retryJob(job.id)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect((await claim())!.attempts).toBe(1);
});

it("rechecks expiry after waiting for a row lock", async () => {
    await seed();
    const lease = (await claim())!;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const holder = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
            UPDATE jobs SET lease_expires_at = clock_timestamp() + interval '100 milliseconds'
            WHERE id = ${lease.id}::uuid
        `;
        locked();
        await tx.$queryRaw`SELECT 1 AS waited FROM pg_sleep(0.25)`;
    });
    await ready;
    const result = finish(lease);
    const [, completed] = await Promise.all([holder, result]);
    expect(completed).toBeNull();
    expect(await prisma.eval.count()).toBe(0);
});

it("accepts one concurrent retry transition and clears ownership before the next claim", async () => {
    await seed();
    const old = (await claim())!;
    const results = await Promise.all(Array.from({ length: 10 }, () => failOrRetryJob({ ...old, error: "retry" })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.find(Boolean)).toMatchObject({ status: "queued", attempts: 1, leaseToken: null, lockedBy: null });
    expect(await claim()).toBeNull();
    await makeJobDue(old.id);
    const next = (await claim())!;
    expect(next.attempts).toBe(2);
    expect(next.leaseToken).not.toBe(old.leaseToken);
});

it("uses database scheduling and leases even when the application clock is two minutes ahead", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 120_000 });
    try {
        const job = await seed();
        const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        expect(job.createdAt.getTime()).toBeGreaterThan(clock.now.getTime() + 60_000);
        expect(job.runAfter.getTime()).toBeLessThanOrEqual(clock.now.getTime());
        const lease = (await claim())!;
        expect(lease.id).toBe(job.id);
        expect(await renewJobLease(lease, 60_000)).toBe(true);
        const completed = await finish(lease);
        expect(completed!.completedAt!.getTime()).toBeLessThan(job.createdAt.getTime());
        const { jobs } = await startRun();
        const [laterClock] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        expect(jobs.every((item) => item.runAfter <= laterClock.now)).toBe(true);
        expect(await claim()).not.toBeNull();
    } finally {
        vi.useRealTimers();
    }
});
