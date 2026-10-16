import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { claimNextJob, createJob, failOrRetryJob, reapExpiredJobs, retryJob } from "../../src/jobs.js";
import { queueWaitTiming } from "../../src/jobTracing.js";
import { makeJobDue, resetDatabase, startRun } from "./helpers.js";

beforeEach(resetDatabase);
async function databaseNow() {
    const [row] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return row.now.getTime();
}

it("leaves pre-migration entry times unknown while defaulting future inserts from Postgres", async () => {
    const migration = await readFile(new URL(
        "../../prisma/migrations/20261016040938_add_job_queue_entry_time/migration.sql", import.meta.url,
    ), "utf8");
    const schema = `queue_migration_${randomUUID().replaceAll("-", "")}`;
    const rollback = new Error("rollback fixture");
    await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        await tx.$executeRawUnsafe(`SET LOCAL search_path = "${schema}"`);
        await tx.$executeRawUnsafe("CREATE TABLE jobs (id text, status text)");
        await tx.$executeRawUnsafe("INSERT INTO jobs VALUES ('old', 'queued')");
        await tx.$executeRawUnsafe(migration);
        await tx.$executeRawUnsafe("INSERT INTO jobs (id,status) VALUES ('new','queued')");
        const rows = await tx.$queryRawUnsafe<Array<{ id: string; queued_at: Date | null }>>(
            "SELECT id,queued_at FROM jobs ORDER BY id",
        );
        expect(rows[0]).toMatchObject({ id: "new", queued_at: expect.any(Date) });
        expect(rows[1]).toEqual({ id: "old", queued_at: null });
        throw rollback;
    })).rejects.toBe(rollback);
});

it("uses the database clock for new single jobs and dataset fan-out despite application skew", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 120000 });
    try {
        const before = await databaseNow();
        const single = await createJob("test", {});
        const run = await startRun();
        const after = await databaseNow();
        for (const job of [single, ...run.jobs]) {
            expect(job.queuedAt!.getTime()).toBeGreaterThanOrEqual(before - 1);
            expect(job.queuedAt!.getTime()).toBeLessThanOrEqual(after);
            expect(job.createdAt.getTime()).toBeGreaterThan(after + 110000);
        }
    } finally { vi.useRealTimers(); }
});

it("returns full queued time and eligibility without assigning one claim twice", async () => {
    const jobs = await Promise.all(Array.from({ length: 12 }, () => createJob("test", {})));
    await prisma.$executeRaw`
        UPDATE jobs SET queued_at = clock_timestamp() - interval '5 seconds',
            run_after = clock_timestamp() - interval '3 seconds'
    `;
    const claims = (await Promise.all(Array.from({ length: 20 }, () => claimNextJob(randomUUID(), 60000))))
        .filter((job) => job !== null);
    expect(claims).toHaveLength(jobs.length);
    expect(new Set(claims.map((job) => job.id)).size).toBe(jobs.length);
    for (const claim of claims) {
        const measured = queueWaitTiming(claim)!;
        expect(measured.totalMs).toBeGreaterThanOrEqual(4999);
        expect(measured.scheduledDelayMs).toBeGreaterThanOrEqual(1999);
        expect(measured.scheduledDelayMs).toBeLessThanOrEqual(2001);
        expect(measured.totalMs).toBe(measured.scheduledDelayMs + measured.readyWaitMs);
    }
});

it.each([false, true])("refreshes the queued interval on recovery (reaper=%s), not on stale writes", async (reaper) => {
    const job = await createJob("test", {}, 2);
    await prisma.job.update({ where: { id: job.id }, data: { queuedAt: new Date(0) } });
    const first = (await claimNextJob(randomUUID(), 60000))!;
    if (reaper) {
        await prisma.job.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(0) } });
    }
    const before = await databaseNow();
    if (reaper) await reapExpiredJobs();
    else await failOrRetryJob({ ...first, error: "retry" });
    const after = await databaseNow();
    const queued = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(queued.status).toBe("queued");
    expect(queued.queuedAt!.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(queued.queuedAt!.getTime()).toBeLessThanOrEqual(after);
    expect(queued.runAfter.getTime() - queued.queuedAt!.getTime()).toBeGreaterThanOrEqual(998);
    expect(queued.runAfter.getTime() - queued.queuedAt!.getTime()).toBeLessThanOrEqual(2000);
    expect(await failOrRetryJob({ ...first, error: "stale" })).toBeNull();
    expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toEqual(queued);
    await makeJobDue(job.id);
    const second = (await claimNextJob(randomUUID(), 60000))!;
    expect(second.queuedAt).toEqual(queued.queuedAt);
    await failOrRetryJob({ ...second, error: "exhausted" });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).queuedAt).toEqual(queued.queuedAt);
});

it("refreshes only the winning manual retry using database time and keeps terminal reaper times", async () => {
    const job = await createJob("test", {}, 1);
    await prisma.job.update({ where: { id: job.id }, data: { queuedAt: new Date(0) } });
    await claimNextJob(randomUUID(), 60000);
    await prisma.job.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(0) } });
    await reapExpiredJobs();
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).queuedAt).toEqual(new Date(0));
    const before = await databaseNow();
    const results = await Promise.all(Array.from({ length: 8 }, () => retryJob(job.id)));
    const after = await databaseNow();
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const queued = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(queued.queuedAt!.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(queued.queuedAt!.getTime()).toBeLessThanOrEqual(after);
    const claimed = (await claimNextJob(randomUUID(), 60000))!;
    expect(claimed.queuedAt).toEqual(queued.queuedAt);
    expect(queueWaitTiming(claimed)!.scheduledDelayMs).toBe(0);
});

it("still claims legacy jobs with unknown queued time", async () => {
    const job = await prisma.job.create({ data: { type: "test", input: {}, queuedAt: null } });
    const claim = (await claimNextJob(randomUUID(), 60000))!;
    expect(claim.id).toBe(job.id);
    expect(queueWaitTiming(claim)).toBeNull();
});
