import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { claimNextJob, failOrRetryJob, reapExpiredJobs, retryJob } from "../../src/jobs.js";
import { makeJobDue, resetDatabase } from "./helpers.js";

beforeEach(resetDatabase);
const workerId = randomUUID();
const claim = () => claimNextJob(workerId, 60_000);
async function databaseNow() {
    const [row] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return row.now.getTime();
}
async function running(attempts = 1, maxAttempts = 10) {
    const job = await prisma.job.create({
        data: { type: "test", input: {}, attempts: attempts - 1, maxAttempts },
    });
    const lease = (await claim())!;
    expect(lease.id).toBe(job.id);
    return lease;
}
async function recover(lease: Awaited<ReturnType<typeof running>>, viaReaper: boolean) {
    if (viaReaper) {
        await prisma.$executeRaw`
            UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second'
            WHERE id = ${lease.id}::uuid
        `;
        await reapExpiredJobs();
    } else {
        await failOrRetryJob({ ...lease, error: "provider unavailable" });
    }
    return prisma.job.findUniqueOrThrow({ where: { id: lease.id } });
}

for (const viaReaper of [false, true]) {
    const path = viaReaper ? "expired lease" : "worker failure";
    it.each([
        [1, 1000, 2000], [2, 2000, 4000], [3, 4000, 8000],
        [4, 8000, 16000], [5, 15000, 30000], [100, 15000, 30000],
        [2_147_483_646, 15000, 30000],
    ])(`${path}: schedules attempt %i between %i and %i ms using database time`, async (attempts, min, max) => {
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 120_000 });
        try {
            const lease = await running(attempts, 2_147_483_647);
            const before = await databaseNow();
            const saved = await recover(lease, viaReaper);
            const after = await databaseNow();
            expect(saved).toMatchObject({
                status: "queued", attempts, completedAt: null,
                lockedBy: null, leaseToken: null, leaseExpiresAt: null,
            });
            expect(saved.runAfter.getTime() - before).toBeGreaterThanOrEqual(min - 1);
            expect(saved.runAfter.getTime() - after).toBeLessThanOrEqual(max);
        } finally {
            vi.useRealTimers();
        }
    });

    it(`${path}: skips delayed work, processes other work and claims a due retry only once`, async () => {
        const lease = await running();
        const saved = await recover(lease, viaReaper);
        const fresh = await prisma.job.create({ data: { type: "test", input: {} } });
        expect((await claim())!.id).toBe(fresh.id);
        expect(await claim()).toBeNull();
        expect((await prisma.job.findUniqueOrThrow({ where: { id: lease.id } })).attempts).toBe(1);
        await makeJobDue(lease.id);
        const results = await Promise.all(Array.from({ length: 10 }, claim));
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(results.find(Boolean)).toMatchObject({ id: lease.id, attempts: 2 });
        expect(results.find(Boolean)!.leaseToken).not.toBe(lease.leaseToken);
        const next = await prisma.job.findUniqueOrThrow({ where: { id: lease.id } });
        expect(await failOrRetryJob({ ...lease, error: "stale failure" })).toBeNull();
        expect(await prisma.job.findUniqueOrThrow({ where: { id: lease.id } })).toEqual(next);
        expect(saved.error).toBe(viaReaper ? "Worker lease expired" : "provider unavailable");
    });

    it(`${path}: fails exhausted jobs and makes explicit manual retries immediately eligible`, async () => {
        const lease = await running(3, 3);
        const before = await databaseNow();
        const failed = await recover(lease, viaReaper);
        const after = await databaseNow();
        expect(failed.status).toBe("dead_letter");
        expect(failed.completedAt!.getTime()).toBeGreaterThanOrEqual(before - 1);
        expect(failed.runAfter.getTime()).toBeLessThanOrEqual(after);
        expect(await claim()).toBeNull();
        expect((await retryJob(lease.id)).ok).toBe(true);
        expect((await claim())!).toMatchObject({ id: lease.id, attempts: 1 });
    });
}

it("chooses jitter independently for each job recovered in one batch", async () => {
    for (let i = 0; i < 20; i++) await running(5);
    await prisma.$executeRaw`UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second'`;
    await reapExpiredJobs();
    const rows = await prisma.job.findMany();
    // With 15,000 possible millisecond delays, identical times across all 20 rows would expose lost jitter.
    expect(new Set(rows.map((job) => job.runAfter.getTime())).size).toBeGreaterThan(1);
    expect(rows.every((job) => job.status === "queued" && job.attempts === 5)).toBe(true);
});
