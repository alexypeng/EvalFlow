import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDatabase, startRun } from "./helpers.js";

beforeEach(resetDatabase);

function worker() {
    const child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
        cwd: process.cwd(),
        env: {
            ...process.env, LLM_PROVIDER: "gemini", GEMINI_API_KEY: "", RATE_LIMIT_MOCK: "true",
            WORKER_CONCURRENCY: "1", POLL_INTERVAL_MS: "10", LEASE_DURATION_MS: "600",
            HEARTBEAT_INTERVAL_MS: "40", WORKER_SHUTDOWN_TIMEOUT_MS: "500",
            WORKER_SHUTDOWN_CLEANUP_MS: "500",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (data) => { logs = (logs + data.toString()).slice(-4000); });
    child.stderr.on("data", (data) => { logs = (logs + data.toString()).slice(-4000); });
    const exited = once(child, "exit");
    return {
        child, exited,
        logs: () => logs,
        async exit() {
            const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
            try { return await exited; } finally { clearTimeout(timeout); }
        },
        async until(predicate: () => Promise<boolean>) {
            const deadline = Date.now() + 8000;
            while (!(await predicate())) {
                if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
                    throw new Error(`Worker did not reach expected state: ${logs}`);
                }
                await sleep(10);
            }
        },
        async stop() {
            const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            try { await exited; } finally { clearTimeout(timeout); }
        },
    };
}

async function cases(count: number) {
    const { jobs } = await startRun();
    const selected = jobs.slice(0, count);
    await prisma.job.deleteMany({ where: { id: { notIn: selected.map((job) => job.id) } } });
    return selected;
}
async function emptyFrozenBucket() {
    await prisma.$executeRaw`
        INSERT INTO provider_rate_limits (provider, tokens, refilled_at)
        VALUES ('mock', 0, clock_timestamp() + interval '1 hour')
    `;
}

it("shares the burst/refill budget across worker processes while keeping waiting jobs leased", async () => {
    await cases(4);
    const workers = [worker(), worker()];
    try {
        await workers[0].until(async () => (await prisma.job.count({ where: { status: "completed" } })) === 4);
        const saved = await prisma.job.findMany();
        expect(saved.every((job) => job.attempts === 1 && job.status === "completed")).toBe(true);
        expect(await prisma.eval.count()).toBe(4);
        const waits = await prisma.trace.findMany({ where: { stepName: "provider_rate_limit" } });
        expect(waits).toHaveLength(4);
        expect(waits.every((trace) => (trace.input as { provider: string }).provider === "mock")).toBe(true);
        expect(waits.some((trace) => trace.latencyMs! > 600)).toBe(true);
        const workerIds = new Set(waits.map((trace) => (trace.input as { workerId: string }).workerId));
        expect(workerIds.size).toBe(2);
        const timestamps = waits.map((trace) => trace.createdAt.getTime()).sort((a, b) => a - b);
        expect(timestamps[2] - timestamps[0]).toBeGreaterThanOrEqual(850);
        expect(timestamps[3] - timestamps[0]).toBeGreaterThanOrEqual(1800);
        expect(await prisma.providerRateLimit.count()).toBe(1);
        const bucket = await prisma.providerRateLimit.findUniqueOrThrow({ where: { provider: "mock" } });
        expect(bucket).toMatchObject({ capacity: 2, refillPerSecond: 1 });
    } finally { await Promise.all(workers.map((run) => run.stop())); }
}, 15_000);

it("interrupts an empty-bucket wait on shutdown without calling the provider or consuming more attempts", async () => {
    const [job] = await cases(1);
    await emptyFrozenBucket();
    const run = worker();
    try {
        await run.until(async () => (await prisma.trace.count({ where: { jobId: job.id } })) === 4);
        const first = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        await run.until(async () => {
            const current = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
            return current.leaseExpiresAt! > first.leaseExpiresAt!;
        });
        run.child.kill("SIGTERM");
        expect(await run.exit()).toEqual([0, null]);
        expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
            status: "queued", attempts: 1, leaseToken: null, lockedBy: null,
        });
        expect(await prisma.trace.count({ where: { stepName: "llm_call" } })).toBe(0);
        expect(await prisma.eval.count()).toBe(0);
        expect((await prisma.providerRateLimit.findUniqueOrThrow({ where: { provider: "mock" } })).tokens).toBe(0);
    } finally { await run.stop(); }
});

it("abandons permit waiting after claim replacement without touching the new owner", async () => {
    const [job] = await cases(1);
    await emptyFrozenBucket();
    const run = worker();
    try {
        await run.until(async () => (await prisma.trace.count({ where: { jobId: job.id } })) === 4);
        await prisma.$executeRaw`
            UPDATE jobs SET locked_by = gen_random_uuid(), lease_token = gen_random_uuid(),
                lease_expires_at = clock_timestamp() + interval '1 minute' WHERE id = ${job.id}::uuid
        `;
        const replacement = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        await run.until(async () => run.logs().includes("abandoning this attempt"));
        expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toEqual(replacement);
        expect(await prisma.trace.count({ where: { stepName: "llm_call" } })).toBe(0);
        expect(await prisma.eval.count()).toBe(0);
    } finally { await run.stop(); }
});
