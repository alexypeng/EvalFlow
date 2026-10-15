import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDatabase, startRun } from "./helpers.js";

beforeEach(resetDatabase);

function startWorker(concurrency = 1, env: NodeJS.ProcessEnv = {}) {
    const child = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
        cwd: process.cwd(),
        env: {
            ...process.env, WORKER_METRICS_PORT: "0", WORKER_CONCURRENCY: String(concurrency),
            LLM_PROVIDER: "mock", GEMINI_API_KEY: "", POLL_INTERVAL_MS: "10",
            LEASE_DURATION_MS: "600", HEARTBEAT_INTERVAL_MS: "50",
            WORKER_SHUTDOWN_TIMEOUT_MS: "2000", WORKER_SHUTDOWN_CLEANUP_MS: "1000",
            ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (data) => { logs = (logs + data.toString()).slice(-5000); });
    child.stderr.on("data", (data) => { logs = (logs + data.toString()).slice(-5000); });
    const exited = once(child, "exit");
    async function until(predicate: () => Promise<boolean>) {
        const deadline = Date.now() + 10_000;
        while (!(await predicate())) {
            if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
                throw new Error(`Worker metrics check timed out: ${logs}`);
            }
            await sleep(15);
        }
    }
    return {
        until,
        async scrape() {
            await until(async () => /Worker metrics listening on port \d+/.test(logs));
            const port = logs.match(/Worker metrics listening on port (\d+)/)![1];
            const response = await fetch(`http://127.0.0.1:${port}/metrics`, {
                signal: AbortSignal.timeout(1000),
            });
            expect(response.status).toBe(200);
            return response.text();
        },
        async stop() {
            const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
            try { expect(await exited).toEqual([0, null]); } finally { clearTimeout(timeout); }
        },
    };
}

async function fixtures(count: number) {
    const { jobs } = await startRun();
    const selected = jobs.slice(0, count);
    await prisma.job.deleteMany({ where: { id: { notIn: selected.map((job) => job.id) } } });
    return selected;
}

function outcomeCount(body: string, outcome: string) {
    return Number(body.match(new RegExp(`evalflow_worker_attempts_total\\{outcome="${outcome}"\\} ([0-9]+)`))?.[1]);
}

it("records accepted completion and duration through the real worker metrics listener", async () => {
    const [job] = await fixtures(1);
    await prisma.job.update({ where: { id: job.id }, data: {
        input: { ...job.input as object, mockConfig: { latencyMs: 150, wrongLabelRate: 1 } },
    } });
    const worker = startWorker();
    try {
        await worker.until(async () => outcomeCount(await worker.scrape(), "completed") === 1);
        const body = await worker.scrape();
        expect(body).toContain('evalflow_worker_attempt_duration_seconds_count{outcome="completed"} 1');
        const sum = body.match(/evalflow_worker_attempt_duration_seconds_sum\{outcome="completed"\} ([\d.e+-]+)/);
        expect(Number(sum![1])).toBeGreaterThanOrEqual(0.15);
        expect(outcomeCount(body, "retried")).toBe(0);
        expect(outcomeCount(body, "unconfirmed")).toBe(0);
        expect(body).toContain('evalflow_llm_call_duration_seconds_count{provider="mock",outcome="success"} 1');
        expect(body).toContain(
            'evalflow_provider_rate_limit_wait_duration_seconds_count{provider="mock",outcome="success"} 0',
        );
        expect(body).not.toContain(job.id);
        expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
            .toMatchObject({ status: "completed", attempts: 1 });
        expect(await prisma.eval.count()).toBe(1);
    } finally { await worker.stop(); }
}, 15_000);

it("counts retry and retry exhaustion as separate attempt outcomes", async () => {
    const [job] = await fixtures(1);
    await prisma.job.update({ where: { id: job.id }, data: {
        maxAttempts: 2, input: { ...job.input as object, mockConfig: { invalidJsonRate: 1 } },
    } });
    const worker = startWorker();
    try {
        await worker.until(async () => outcomeCount(await worker.scrape(), "dead_letter") === 1);
        const body = await worker.scrape();
        expect(outcomeCount(body, "retried")).toBe(1);
        expect(outcomeCount(body, "completed")).toBe(0);
        // The model returned text successfully; JSON validation failed afterwards.
        expect(body).toContain('evalflow_llm_call_duration_seconds_count{provider="mock",outcome="success"} 2');
        expect(body).toContain('evalflow_llm_call_duration_seconds_count{provider="mock",outcome="error"} 0');
        expect(body).toContain('evalflow_worker_attempt_duration_seconds_count{outcome="retried"} 1');
        expect(body).toContain('evalflow_worker_attempt_duration_seconds_count{outcome="dead_letter"} 1');
        expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
            .toMatchObject({ status: "dead_letter", attempts: 2 });
    } finally { await worker.stop(); }
}, 15_000);

it("separates real permit contention from LLM execution time", async () => {
    const jobs = await fixtures(3);
    for (const job of jobs) {
        await prisma.job.update({ where: { id: job.id }, data: {
            input: { ...job.input as object, mockConfig: { latencyMs: 100 } },
        } });
    }
    const worker = startWorker(3, { RATE_LIMIT_MOCK: "true" });
    try {
        await worker.until(async () => outcomeCount(await worker.scrape(), "completed") === 3);
        const body = await worker.scrape();
        expect(body).toContain(
            'evalflow_provider_rate_limit_wait_duration_seconds_count{provider="mock",outcome="success"} 3',
        );
        expect(body).toContain('evalflow_llm_call_duration_seconds_count{provider="mock",outcome="success"} 3');
        const wait = body.match(
            /evalflow_provider_rate_limit_wait_duration_seconds_sum\{provider="mock",outcome="success"\} ([\d.e+-]+)/,
        );
        expect(Number(wait![1])).toBeGreaterThan(0.6);
        const llm = body.match(/evalflow_llm_call_duration_seconds_sum\{provider="mock",outcome="success"\} ([\d.e+-]+)/);
        expect(Number(llm![1])).toBeGreaterThanOrEqual(0.27);
    } finally { await worker.stop(); }
}, 15_000);

it("records a rejected LLM wrapper call as an error without making a real provider request", async () => {
    const [job] = await fixtures(1);
    // Existing wrapper validation rejects per-case mock settings without a case ID.
    await prisma.job.update({ where: { id: job.id }, data: {
        caseId: null, maxAttempts: 1, input: { ...job.input as object, mockConfig: {} },
    } });
    const worker = startWorker();
    try {
        await worker.until(async () => outcomeCount(await worker.scrape(), "dead_letter") === 1);
        const body = await worker.scrape();
        expect(body).toContain('evalflow_llm_call_duration_seconds_count{provider="mock",outcome="error"} 1');
        expect(body).toContain('evalflow_llm_call_duration_seconds_count{provider="mock",outcome="success"} 0');
    } finally { await worker.stop(); }
}, 15_000);

it("records lost ownership while waiting for a permit without starting the LLM call", async () => {
    const [job] = await fixtures(1);
    await prisma.$executeRaw`
        INSERT INTO provider_rate_limits (provider, tokens, refilled_at)
        VALUES ('mock', 0, clock_timestamp() + interval '1 hour')
    `;
    const worker = startWorker(1, { RATE_LIMIT_MOCK: "true" });
    try {
        await worker.until(async () => (await prisma.trace.count({ where: { jobId: job.id } })) === 4);
        await prisma.job.update({ where: { id: job.id }, data: {
            lockedBy: randomUUID(), leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000),
        } });
        const replacement = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        await worker.until(async () => outcomeCount(await worker.scrape(), "lease_lost") === 1);
        const body = await worker.scrape();
        expect(body).toContain(
            'evalflow_provider_rate_limit_wait_duration_seconds_count{provider="mock",outcome="lease_lost"} 1',
        );
        expect(body).toContain('evalflow_llm_call_duration_seconds_count{provider="mock",outcome="success"} 0');
        expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toEqual(replacement);
    } finally { await worker.stop(); }
}, 15_000);

it("records a discarded lease without counting completion or modifying the replacement claim", async () => {
    const [job] = await fixtures(1);
    await prisma.job.update({ where: { id: job.id }, data: {
        input: { ...job.input as object, mockConfig: { latencyMs: 1500 } },
    } });
    const worker = startWorker();
    try {
        await worker.until(async () => (await prisma.trace.count({ where: { jobId: job.id } })) === 4);
        await prisma.job.update({ where: { id: job.id }, data: {
            lockedBy: randomUUID(), leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000),
        } });
        const replacement = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        await worker.until(async () => outcomeCount(await worker.scrape(), "lease_lost") === 1);
        const body = await worker.scrape();
        expect(outcomeCount(body, "completed")).toBe(0);
        expect(outcomeCount(body, "retried")).toBe(0);
        expect(outcomeCount(body, "dead_letter")).toBe(0);
        expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toEqual(replacement);
        expect(await prisma.eval.count()).toBe(0);
    } finally { await worker.stop(); }
}, 15_000);

it("records each concurrent slot's claim once", async () => {
    await fixtures(8);
    const worker = startWorker(4);
    try {
        await worker.until(async () => outcomeCount(await worker.scrape(), "completed") === 8);
        const body = await worker.scrape();
        expect(body).toContain('evalflow_worker_attempt_duration_seconds_count{outcome="completed"} 8');
        expect(outcomeCount(body, "lease_lost")).toBe(0);
        expect(outcomeCount(body, "unconfirmed")).toBe(0);
        expect(await prisma.eval.count()).toBe(8);
    } finally { await worker.stop(); }
}, 15_000);
