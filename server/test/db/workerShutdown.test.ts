import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { claimNextJob, reapExpiredJobs } from "../../src/jobs.js";
import { loadDataset, readDatasetFile } from "../../src/datasets.js";
import { makeJobDue, resetDatabase, retentionV1 } from "./helpers.js";

beforeEach(resetDatabase);

function startWorker(env: NodeJS.ProcessEnv = {}) {
    const worker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
        cwd: process.cwd(),
        env: {
            ...process.env, LLM_PROVIDER: "mock", GEMINI_API_KEY: "", WORKER_CONCURRENCY: "1",
            POLL_INTERVAL_MS: "10", LEASE_DURATION_MS: "600", HEARTBEAT_INTERVAL_MS: "50",
            WORKER_SHUTDOWN_TIMEOUT_MS: "3000", WORKER_SHUTDOWN_CLEANUP_MS: "1000", ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    worker.stdout.on("data", (data) => { logs = (logs + data.toString()).slice(-5000); });
    worker.stderr.on("data", (data) => { logs = (logs + data.toString()).slice(-5000); });
    const exited = once(worker, "exit");
    return {
        worker, exited,
        logs: () => logs,
        async until(predicate: () => boolean | Promise<boolean>) {
            const deadline = Date.now() + 8000;
            while (!(await predicate())) {
                if (worker.exitCode !== null || worker.signalCode !== null || Date.now() > deadline) {
                    throw new Error(`Worker did not reach expected state: ${logs}`);
                }
                await sleep(10);
            }
        },
        async exit() {
            const timeout = setTimeout(() => worker.kill("SIGKILL"), 5000);
            try { return await exited; } finally { clearTimeout(timeout); }
        },
        async stop() {
            if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
            await exited;
        },
    };
}

async function seed(latencyMs: number, maxAttempts = 3) {
    await loadDataset(await readDatasetFile(retentionV1));
    const datasetCase = await prisma.datasetCase.findFirstOrThrow();
    return prisma.job.create({ data: {
        type: "retention_risk_analysis", caseId: datasetCase.id,
        input: { userId: "user_test", mockConfig: { latencyMs } }, maxAttempts,
    } });
}
const toolCallsFinished = (id: string) => async () => (await prisma.trace.count({ where: { jobId: id } })) === 4;

it.each(["SIGTERM", "SIGINT"] as const)("interrupts idle sleep and exits cleanly on %s", async (signal) => {
    const run = startWorker({ POLL_INTERVAL_MS: "60000" });
    try {
        await run.until(() => run.logs().includes("Worker "));
        const before = Date.now();
        run.worker.kill(signal);
        expect(await run.exit()).toEqual([0, null]);
        expect(Date.now() - before).toBeLessThan(2500);
        expect(run.logs()).toContain("Worker shutdown complete");
        expect(await prisma.job.count()).toBe(0);
    } finally { await run.stop(); }
});

it("drains active work with heartbeats and does not claim a queued successor", async () => {
    const job = await seed(1500);
    const successor = await seed(0);
    const run = startWorker();
    try {
        await run.until(toolCallsFinished(job.id));
        const original = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        run.worker.kill("SIGTERM");
        await run.until(() => run.logs().includes("stopping claims"));
        await run.until(async () => {
            const current = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
            return current.status === "running" && current.leaseExpiresAt! > original.leaseExpiresAt!;
        });
        expect(await run.exit()).toEqual([0, null]);
        expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
            status: "completed", attempts: 1, lockedBy: null, leaseToken: null, leaseExpiresAt: null,
        });
        expect(await prisma.eval.count({ where: { jobId: job.id } })).toBe(1);
        expect(await prisma.job.findUniqueOrThrow({ where: { id: successor.id } })).toMatchObject({
            status: "queued", attempts: 0,
        });
    } finally { await run.stop(); }
});

it.each([3, 1])("abandons overdue work without refunding attempts; maxAttempts=%i", async (maxAttempts) => {
    const job = await seed(10_000, maxAttempts);
    const run = startWorker({ WORKER_SHUTDOWN_TIMEOUT_MS: "150" });
    try {
        await run.until(toolCallsFinished(job.id));
        const original = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        run.worker.kill("SIGTERM");
        await run.until(() => run.logs().includes("stopping claims"));
        // Repeated signals must not restart the grace period or bypass the cleanup path.
        run.worker.kill("SIGINT");
        expect(await run.exit()).toEqual([0, null]);
        expect(run.logs()).toContain("shutdown deadline reached");
        const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        expect(saved).toMatchObject({
            status: maxAttempts === 1 ? "dead_letter" : "queued", attempts: 1,
            error: "Worker shutdown deadline exceeded", lockedBy: null, leaseToken: null, leaseExpiresAt: null,
            result: null,
        });
        expect(await prisma.eval.count()).toBe(0);
        expect(await prisma.trace.count({ where: { jobId: job.id } })).toBe(4);
        if (maxAttempts > 1) {
            expect(saved.runAfter.getTime()).toBeGreaterThan(Date.now());
            expect(await claimNextJob(randomUUID(), 60_000)).toBeNull();
            await makeJobDue(job.id);
            const next = (await claimNextJob(randomUUID(), 60_000))!;
            expect(next).toMatchObject({ id: job.id, attempts: 2 });
            expect(next.leaseToken).not.toBe(original.leaseToken);
        }
    } finally { await run.stop(); }
});

it("does not release another worker's replacement claim at the deadline", async () => {
    const job = await seed(10_000);
    const run = startWorker({ WORKER_SHUTDOWN_TIMEOUT_MS: "100" });
    try {
        await run.until(toolCallsFinished(job.id));
        await prisma.$executeRaw`
            UPDATE jobs SET locked_by = gen_random_uuid(), lease_token = gen_random_uuid(),
                lease_expires_at = clock_timestamp() + interval '1 minute' WHERE id = ${job.id}::uuid
        `;
        const replacement = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        run.worker.kill("SIGTERM");
        expect(await run.exit()).toEqual([0, null]);
        expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toEqual(replacement);
        expect(await prisma.eval.count()).toBe(0);
    } finally { await run.stop(); }
});

it("releases a claim that returns after the signal without executing its pipeline", async () => {
    const job = await seed(0);
    let release!: () => void;
    let notify!: () => void;
    const locked = new Promise<void>((resolve) => { notify = resolve; });
    const unlock = new Promise<void>((resolve) => { release = resolve; });
    const holder = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`LOCK TABLE jobs IN ACCESS EXCLUSIVE MODE`;
        notify();
        await unlock;
    });
    await locked;
    const run = startWorker();
    try {
        await run.until(async () => {
            const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
                SELECT count(*)::int AS count FROM pg_stat_activity
                WHERE datname = current_database() AND state = 'active' AND wait_event_type = 'Lock'
                    AND query LIKE '%lease_expires_at = clock_timestamp()%'
            `;
            return row.count > 0;
        });
        run.worker.kill("SIGTERM");
        await run.until(() => run.logs().includes("stopping claims"));
        release();
        await holder;
        expect(await run.exit()).toEqual([0, null]);
        expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
            status: "queued", attempts: 1, lockedBy: null, leaseToken: null,
            error: "Worker shutdown before execution",
        });
        expect(await prisma.trace.count()).toBe(0);
        expect(await prisma.eval.count()).toBe(0);
    } finally {
        release();
        await holder;
        await run.stop();
    }
});

it("bounds cleanup when a heartbeat is blocked, leaving expiry recovery to the reaper", async () => {
    const job = await seed(10_000);
    const run = startWorker({ WORKER_SHUTDOWN_TIMEOUT_MS: "100", WORKER_SHUTDOWN_CLEANUP_MS: "200" });
    let release!: () => void;
    let holder: Promise<unknown> | undefined;
    try {
        await run.until(toolCallsFinished(job.id));
        let notify!: () => void;
        const locked = new Promise<void>((resolve) => { notify = resolve; });
        const unlock = new Promise<void>((resolve) => { release = resolve; });
        holder = prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
            notify();
            await unlock;
        });
        await locked;
        // Give the next heartbeat time to issue its renewal while the row is locked.
        await sleep(100);
        run.worker.kill("SIGTERM");
        expect(await run.exit()).toEqual([1, null]);
        expect(run.logs()).toContain("cleanup timed out");
        release();
        await holder;
        holder = undefined;
        expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("running");
        expect(await prisma.eval.count()).toBe(0);
        await prisma.$executeRaw`
            UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${job.id}::uuid
        `;
        expect(await reapExpiredJobs()).toEqual([{ id: job.id, status: "queued" }]);
    } finally {
        release?.();
        if (holder) await holder;
        await run.stop();
    }
});
