import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDatabase, startRun } from "./helpers.js";

beforeEach(resetDatabase);

it.each([false, true])("keeps a slow model call leased; replaced claim=%s", async (replaceClaim) => {
    const { jobs } = await startRun();
    const job = jobs[0];
    await prisma.job.deleteMany({ where: { id: { not: job.id } } });
    await prisma.job.update({
        where: { id: job.id },
        data: { input: { ...job.input as object, mockConfig: { latencyMs: 1_500 } } },
    });
    const worker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
        cwd: process.cwd(),
        env: {
            ...process.env, LLM_PROVIDER: "mock", GEMINI_API_KEY: "", WORKER_CONCURRENCY: "1",
            POLL_INTERVAL_MS: "10", LEASE_DURATION_MS: "500", HEARTBEAT_INTERVAL_MS: "50",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    worker.stdout.on("data", (data) => { logs = (logs + data.toString()).slice(-2000); });
    worker.stderr.on("data", (data) => { logs = (logs + data.toString()).slice(-2000); });
    const exited = once(worker, "exit");
    async function until(predicate: () => Promise<boolean>) {
        const deadline = Date.now() + 10_000;
        while (!(await predicate())) {
            if (worker.exitCode !== null || worker.signalCode !== null || Date.now() > deadline) {
                throw new Error(`Worker did not reach expected state: ${logs}`);
            }
            await sleep(10);
        }
    }
    try {
        // Four tool traces show the worker has reached the slow model call.
        await until(async () => (await prisma.trace.count({ where: { jobId: job.id } })) === 4);
        const original = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        if (replaceClaim) {
            // Emulate a later claim without implementing the future reaper in this piece.
            await prisma.$executeRaw`
                UPDATE jobs SET locked_by = gen_random_uuid(), lease_token = gen_random_uuid(),
                    lease_expires_at = clock_timestamp() + interval '1 minute'
                WHERE id = ${job.id}::uuid
            `;
            const replacement = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
            await until(async () => logs.includes("abandoning this attempt"));
            expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toEqual(replacement);
            expect(await prisma.eval.count()).toBe(0);
        } else {
            await until(async () => {
                const current = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
                return current.leaseExpiresAt !== null && current.leaseExpiresAt > original.leaseExpiresAt!;
            });
            await until(async () => (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status === "completed");
            const completed = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
            expect(completed).toMatchObject({ attempts: 1, lockedBy: null, leaseToken: null, leaseExpiresAt: null });
            expect(completed.latencyMs).toBeGreaterThanOrEqual(1_500);
            expect(await prisma.eval.count({ where: { jobId: job.id } })).toBe(1);
            const call = await prisma.trace.findFirstOrThrow({ where: { jobId: job.id, stepName: "llm_call" } });
            expect(call.input).toMatchObject({ workerId: original.lockedBy, leaseToken: original.leaseToken });
        }
    } finally {
        worker.kill("SIGTERM");
        await exited;
    }
}, 15_000);
