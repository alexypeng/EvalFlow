import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { claimNextJob, completeJob, failOrRetryJob, reapExpiredJobs, renewJobLease } from "../../src/jobs.js";
import { makeJobDue, resetDatabase } from "./helpers.js";

beforeEach(resetDatabase);
const workerId = randomUUID();
async function claimed(maxAttempts = 3) {
    await prisma.job.create({ data: { type: "retention_risk_analysis", input: {}, maxAttempts } });
    return (await claimNextJob(workerId, 60_000))!;
}
async function expire(id: string) {
    await prisma.$executeRaw`
        UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${id}::uuid
    `;
}

it("recovers only expired running jobs, preserves attempt counts and delays retries", async () => {
    const expired = await claimed();
    const live = await claimed();
    const exhausted = await claimed(1);
    const queued = await prisma.job.create({ data: { type: "test", input: {} } });
    const failed = await prisma.job.create({ data: { type: "test", input: {}, status: "failed" } });
    const completed = await prisma.job.create({ data: { type: "test", input: {}, status: "completed" } });
    await expire(expired.id);
    await expire(exhausted.id);
    const untouched = await prisma.job.findMany({
        where: { id: { in: [live.id, queued.id, failed.id, completed.id] } }, orderBy: { id: "asc" },
    });
    expect(await reapExpiredJobs()).toHaveLength(2);
    const recovered = await prisma.job.findUniqueOrThrow({ where: { id: expired.id } });
    expect(recovered).toMatchObject({
        status: "queued", attempts: 1, lockedBy: null, leaseToken: null, leaseExpiresAt: null,
        completedAt: null, error: "Worker lease expired",
    });
    const terminal = await prisma.job.findUniqueOrThrow({ where: { id: exhausted.id } });
    expect(terminal).toMatchObject({
        status: "failed", attempts: 1, lockedBy: null, leaseToken: null, leaseExpiresAt: null,
    });
    expect(terminal.completedAt).not.toBeNull();
    expect(await prisma.job.findMany({
        where: { id: { in: untouched.map((job) => job.id) } }, orderBy: { id: "asc" },
    })).toEqual(untouched);
    expect(await reapExpiredJobs()).toEqual([]);
    await prisma.job.delete({ where: { id: queued.id } });
    expect(await claimNextJob(workerId, 60_000)).toBeNull();
    await makeJobDue(expired.id);
    const next = (await claimNextJob(workerId, 60_000))!;
    expect(next).toMatchObject({ id: expired.id, attempts: 2 });
    expect(next.leaseToken).not.toBe(expired.leaseToken);
    expect(await renewJobLease(expired, 60_000)).toBe(false);
    expect(await failOrRetryJob({ ...expired, error: "stale" })).toBeNull();
    expect(await completeJob({
        ...expired, result: {}, latencyMs: 1, promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCost: 0,
        evaluation: {
            validJson: true, hasRequiredFields: true, evidenceIncluded: true, evidenceSupported: true,
            reasonableRiskLabel: true, taskCompletionScore: 100, notes: "stale",
        },
    })).toBeNull();
    expect(await prisma.eval.count()).toBe(0);
});

it("bounds each batch and lets concurrent reapers recover each job only once", async () => {
    const leases = [];
    for (let i = 0; i < 12; i++) leases.push(await claimed());
    for (const lease of leases) await expire(lease.id);
    const batches = await Promise.all(Array.from({ length: 8 }, () => reapExpiredJobs(2)));
    expect(batches.every((batch) => batch.length <= 2)).toBe(true);
    const ids = batches.flat().map((job) => job.id);
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
    expect(await prisma.job.count({ where: { status: "queued", attempts: 1 } })).toBe(12);
});

it("skips a locked job during renewal and leaves its renewed lease alone", async () => {
    const lease = await claimed();
    await expire(lease.id);
    let notify!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => { notify = resolve; });
    const unlocked = new Promise<void>((resolve) => { release = resolve; });
    // Hold a renewal-style row lock; the reaper must not block or overwrite its update.
    const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${lease.id}::uuid FOR UPDATE`;
        notify();
        await unlocked;
        await tx.$executeRaw`
            UPDATE jobs SET lease_expires_at = clock_timestamp() + interval '1 minute' WHERE id = ${lease.id}::uuid
        `;
    });
    try {
        await locked;
        expect(await reapExpiredJobs()).toEqual([]);
    } finally {
        release();
        await holder;
    }
    expect(await reapExpiredJobs()).toEqual([]);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: lease.id } })).status).toBe("running");
});

it("serializes recovery racing with a heartbeat on an expired claim", async () => {
    const lease = await claimed();
    await expire(lease.id);
    const [recovered, renewed] = await Promise.all([reapExpiredJobs(), renewJobLease(lease, 60_000)]);
    expect(renewed).toBe(false);
    // SKIP LOCKED may skip the heartbeat's row; the following scan must recover it.
    const later = await reapExpiredJobs();
    expect([...recovered, ...later]).toEqual([{ id: lease.id, status: "queued" }]);
});

it("runs recovery in a separate process and shuts down cleanly", async () => {
    const lease = await claimed();
    const reaper = spawn(process.execPath, ["--import", "tsx", "src/reaper.ts"], {
        cwd: process.cwd(), env: { ...process.env, REAPER_INTERVAL_MS: "25", REAPER_BATCH_SIZE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(reaper, "exit");
    let logs = "";
    reaper.stdout.on("data", (data) => { logs = (logs + data.toString()).slice(-2000); });
    reaper.stderr.on("data", (data) => { logs = (logs + data.toString()).slice(-2000); });
    try {
        // Expire after startup to exercise recurring scans, not only the first scan.
        const deadline = Date.now() + 8000;
        while (!logs.includes("Reaper scanning")) {
            if (reaper.exitCode !== null || Date.now() > deadline) throw new Error(logs || "Reaper did not start");
            await sleep(10);
        }
        await expire(lease.id);
        while ((await prisma.job.findUniqueOrThrow({ where: { id: lease.id } })).status === "running") {
            if (reaper.exitCode !== null || Date.now() > deadline) {
                throw new Error(logs || "Reaper did not recover job");
            }
            await sleep(10);
        }
    } finally {
        reaper.kill("SIGTERM");
        const timeout = setTimeout(() => reaper.kill("SIGKILL"), 3000);
        const [code, signal] = await exited;
        clearTimeout(timeout);
        expect({ code, signal }).toEqual({ code: 0, signal: null });
    }
}, 15_000);
