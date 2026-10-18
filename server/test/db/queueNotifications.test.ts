import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, type Notification } from "pg";
import { beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { claimNextJob, createJob, failOrRetryJob, reapExpiredJobs, renewJobLease, retryJob } from "../../src/jobs.js";
import { createIdleWakeup, startQueueListener } from "../../src/queueWakeup.js";
import { makeJobDue, resetDatabase, startRun } from "./helpers.js";

beforeEach(resetDatabase);
async function until(predicate: () => boolean | Promise<boolean>, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error("Notification test timed out");
        await sleep(10);
    }
}
async function observer() {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    const received: Notification[] = [];
    client.on("notification", (message) => received.push(message));
    await client.connect();
    await client.query("LISTEN evalflow_jobs");
    return {
        client, messages: () => received.filter((message) => message.payload === ""),
        async flush() {
            // A later committed marker on the same channel proves earlier notifications arrived.
            const marker = randomUUID();
            await client.query("SELECT pg_notify('evalflow_jobs', $1)", [marker]);
            await until(() => received.some((message) => message.payload === marker));
        },
    };
}
function gate() {
    let resolve!: () => void;
    return { promise: new Promise<void>((done) => { resolve = done; }), open: () => resolve() };
}

it("delivers queued inserts only after commit, and never for rolled-back inserts", async () => {
    const seen = await observer(), inserted = gate(), commit = gate();
    const transaction = prisma.$transaction(async (tx) => {
        await tx.job.create({ data: { type: "test", input: {} } });
        inserted.open();
        await commit.promise;
    });
    try {
        await inserted.promise;
        await seen.flush();
        expect(seen.messages()).toHaveLength(0);
        commit.open();
        await transaction;
        await seen.flush();
        expect(seen.messages()).toHaveLength(1);
        await expect(prisma.$transaction(async (tx) => {
            await tx.job.create({ data: { type: "test", input: {} } });
            throw new Error("rollback");
        })).rejects.toThrow("rollback");
        await seen.flush();
        expect(seen.messages()).toHaveLength(1);
        expect(await prisma.job.count()).toBe(1);
    } finally { commit.open(); await transaction; await seen.client.end(); }
});

it("covers individual jobs, bulk run fan-out and direct inserts with no job data in notifications", async () => {
    const seen = await observer();
    try {
        await createJob("test", {});
        await seen.flush();
        expect(seen.messages()).toHaveLength(1);
        const { jobs } = await startRun();
        expect(jobs).toHaveLength(20);
        await seen.flush();
        // Empty payloads coalesce within the single run transaction.
        expect(seen.messages()).toHaveLength(2);
        await prisma.job.create({ data: { type: "direct", input: { private: "not a payload" } } });
        await seen.flush();
        expect(seen.messages()).toHaveLength(3);
        expect(seen.messages().every((message) => message.payload === "")).toBe(true);
    } finally { await seen.client.end(); }
});

it("does not notify for claims, heartbeats, terminal jobs or unchanged queued status", async () => {
    const seen = await observer();
    try {
        const job = await createJob("test", {});
        await seen.flush();
        await makeJobDue(job.id);
        await prisma.job.update({ where: { id: job.id }, data: { status: "queued", input: { updated: true } } });
        const claim = await claimNextJob(randomUUID(), 60_000);
        expect(claim).not.toBeNull();
        await renewJobLease(claim!, 60_000);
        await prisma.job.update({ where: { id: job.id }, data: { status: "completed" } });
        await prisma.job.create({ data: { type: "test", input: {}, status: "dead_letter" } });
        await seen.flush();
        expect(seen.messages()).toHaveLength(1);
    } finally { await seen.client.end(); }
});

it("notifies automatic retry, expired-lease recovery and manual retry, excluding dead letters", async () => {
    const seen = await observer();
    try {
        const job = await createJob("test", {}, 3);
        const claim = await claimNextJob(randomUUID(), 60_000);
        await failOrRetryJob({ ...claim!, error: "retry" });
        await seen.flush();
        expect(seen.messages()).toHaveLength(2);
        await makeJobDue(job.id);
        const next = await claimNextJob(randomUUID(), 60_000);
        await prisma.$executeRaw`UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second'
            WHERE id = ${next!.id}::uuid`;
        await reapExpiredJobs();
        await seen.flush();
        expect(seen.messages()).toHaveLength(3);
        await makeJobDue(job.id);
        const final = await claimNextJob(randomUUID(), 60_000);
        await failOrRetryJob({ ...final!, error: "exhausted" });
        await seen.flush();
        expect(seen.messages()).toHaveLength(3);
        expect((await retryJob(job.id)).ok).toBe(true);
        await seen.flush();
        expect(seen.messages()).toHaveLength(4);
    } finally { await seen.client.end(); }
});

it("wakes for new work and re-registers/rechecks after an actual listener disconnect", async () => {
    const controller = new AbortController();
    const idle = createIdleWakeup(60_000, controller.signal);
    const states: string[] = [];
    const listener = startQueueListener({ connectionString: process.env.DATABASE_URL,
        signal: controller.signal, wake: () => idle.wake(), onState: (state) => states.push(state) });
    try {
        await until(() => states.includes("listening"));
        const waiting = idle.wait(idle.version());
        const first = await createJob("test", {});
        await Promise.race([waiting, sleep(3000).then(() => { throw new Error("Notification did not wake worker"); })]);
        expect((await claimNextJob(randomUUID(), 60_000))?.id).toBe(first.id);
        await prisma.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE application_name = 'evalflow-worker-listener' AND datname = current_database()`;
        await until(() => states.includes("disconnected"));
        // This insertion has no listening client; only re-registration's queue check can recover it here.
        const missed = await createJob("test", {});
        const generation = idle.version();
        await until(() => states.filter((state) => state === "listening").length === 2);
        expect(idle.version()).toBeGreaterThan(generation);
        expect((await claimNextJob(randomUUID(), 60_000))?.id).toBe(missed.id);
    } finally { controller.abort(); await listener.closed; }
}, 10_000);

function worker(concurrency: number) {
    const child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
        cwd: process.cwd(), env: { ...process.env, WORKER_WAKEUP_MODE: "notify", LLM_PROVIDER: "mock",
            POLL_INTERVAL_MS: "60000", WORKER_CONCURRENCY: String(concurrency), WORKER_METRICS_PORT: "0",
            WORKER_SHUTDOWN_TIMEOUT_MS: "3000", WORKER_SHUTDOWN_CLEANUP_MS: "1000" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (data) => { logs = (logs + data.toString()).slice(-8000); });
    child.stderr.on("data", (data) => { logs = (logs + data.toString()).slice(-8000); });
    const exited = once(child, "exit");
    return { child, logs: () => logs,
        ready: () => until(() => {
            if (child.exitCode !== null) throw new Error(logs);
            return logs.includes("Worker queue listener listening");
        }),
        async stop() {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
            try { return await exited; } finally { clearTimeout(kill); }
        },
    };
}

it("processes one committed burst across concurrent worker processes/slots exactly once and shuts down", async () => {
    const workers = [worker(2), worker(2)];
    try {
        await Promise.all(workers.map((run) => run.ready()));
        const { jobs } = await startRun();
        await until(async () => await prisma.job.count({ where: { status: "completed" } }) === jobs.length);
        const saved = await prisma.job.findMany({ include: { _count: { select: { evals: true } } } });
        expect(saved.every((job) => job.attempts === 1 && job._count.evals === 1)).toBe(true);
        expect(saved).toHaveLength(20);
        const identities = await prisma.trace.findMany({ where: { stepName: "llm_call" } });
        expect(new Set(identities.map((trace) => (trace.input as { workerId: string }).workerId)).size).toBe(2);
        const exits = await Promise.all(workers.map((run) => run.stop()));
        expect(exits).toEqual([[0, null], [0, null]]);
        expect(workers.every((run) => run.logs().includes("Worker shutdown complete"))).toBe(true);
    } finally { await Promise.all(workers.map((run) => run.stop())); }
}, 15_000);

it("discovers pre-start jobs and future eligibility through the fixed one-second backup without another notification", async () => {
    const job = await prisma.job.create({ data: { type: "retention_risk_analysis", input: { userId: "user_test" },
        runAfter: new Date(Date.now() + 2000) } });
    const run = worker(1);
    try {
        await run.ready();
        expect(run.logs()).toContain("idle check 1000ms");
        expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("queued");
        await until(async () => (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status === "completed");
        const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id }, include: { _count: { select: { evals: true } } } });
        expect(saved.attempts).toBe(1);
        expect(saved._count.evals).toBe(1);
        expect(saved.startedAt!.getTime()).toBeGreaterThanOrEqual(saved.runAfter.getTime());
        expect(await run.stop()).toEqual([0, null]);
    } finally { await run.stop(); }
}, 10_000);
