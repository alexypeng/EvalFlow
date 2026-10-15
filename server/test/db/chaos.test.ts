import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { prisma } from "../../src/db.js";
import { createRun } from "../../src/runs.js";
import { loadDataset, readDatasetFile } from "../../src/datasets.js";
import { resetDatabase, retentionV1 } from "./helpers.js";
import { ChaosHarness } from "./chaosHarness.js";

beforeEach(resetDatabase);
const seed = z.coerce.number().int().min(0).max(0xffff_ffff).parse(process.env.CHAOS_SEED ?? 20261015);

// Seed the crash choices; OS scheduling and database backoff jitter still vary between runs.
function random(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = Math.imul(state ^ (state >>> 15), state | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 2 ** 32;
    };
}

type Candidate = { id: string; lockedBy: string; leaseToken: string; attempts: number };
async function activeModelCalls() {
    // Only select fresh admissions: the 750ms mock call leaves time to kill genuinely active work.
    return prisma.$queryRaw<Candidate[]>`
        SELECT j.id, j.locked_by AS "lockedBy", j.lease_token AS "leaseToken", j.attempts
        FROM jobs j JOIN traces t ON t.job_id = j.id
        WHERE j.status = 'running' AND t.step_name = 'provider_rate_limit'
            AND t.input->>'leaseToken' = j.lease_token::text
            AND t.created_at > clock_timestamp() - interval '250 milliseconds'
            AND NOT EXISTS (
                SELECT 1 FROM traces done WHERE done.job_id = j.id AND done.step_name = 'llm_call'
                    AND done.input->>'leaseToken' = j.lease_token::text
            )
        ORDER BY j.id
    `;
}

async function diagnostics(harness: ChaosHarness, error: unknown) {
    let jobs: unknown;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        jobs = await Promise.race([
            prisma.job.findMany({ select: {
                id: true, status: true, attempts: true, maxAttempts: true, error: true,
                lockedBy: true, leaseToken: true, leaseExpiresAt: true, runAfter: true,
            } }),
            new Promise((resolve) => {
                timeout = setTimeout(() => resolve("Database diagnostics timed out"), 2000);
            }),
        ]);
    } catch { jobs = "Database unavailable during diagnostics"; }
    finally { clearTimeout(timeout); }
    return new Error(JSON.stringify({
        seed, error: error instanceof Error ? error.message : String(error), jobs, processes: harness.diagnostics(),
    }, null, 2), { cause: error });
}

it("recovers 20 jobs after four seeded worker crashes with one accepted completion/eval per job", async () => {
    await loadDataset(await readDatasetFile(retentionV1));
    const created = await createRun({
        datasetName: "retention", datasetVersion: 1, promptVersion: "v1", mockConfig: { latencyMs: 750 },
    });
    if (!created.ok) throw new Error("Expected mock run creation");
    // Four injected crashes can consume at most four attempts on one job; leave room for its final execution.
    await prisma.job.updateMany({ where: { runId: created.run.id }, data: { maxAttempts: 6 } });
    const harness = new ChaosHarness();
    const choose = random(seed);
    const crashes: Array<{ slot: number; id: string; leaseToken: string }> = [];
    try {
        harness.startReaper();
        for (let slot = 0; slot < 3; slot++) harness.startWorker(slot);
        await harness.until(() => [...harness.workers.values()].every((worker) => worker.workerId !== undefined));
        for (let round = 0; round < 4; round++) {
            await sleep(50 + Math.floor(choose() * 100));
            let candidates: Array<Candidate & { slot: number }> = [];
            await harness.until(async () => {
                const active = await activeModelCalls();
                candidates = active.flatMap((job) => {
                    const worker = [...harness.workers.values()].find((worker) => worker.workerId === job.lockedBy);
                    return worker ? [{ ...job, slot: worker.slot }] : [];
                }).sort((a, b) => a.slot - b.slot);
                return candidates.length > 0;
            });
            const target = candidates[Math.floor(choose() * candidates.length)];
            expect(await harness.crash(target.slot)).toEqual({ code: null, signal: "SIGKILL" });
            // Prove this bypassed graceful release and left real orphaned work for the reaper.
            const orphan = await prisma.job.findUniqueOrThrow({ where: { id: target.id } });
            expect(orphan).toMatchObject({
                status: "running", lockedBy: target.lockedBy, leaseToken: target.leaseToken, attempts: target.attempts,
            });
            crashes.push({ slot: target.slot, id: target.id, leaseToken: target.leaseToken });
            console.log(`[chaos] ${JSON.stringify({ seed, round: round + 1, ...crashes.at(-1) })}`);
            harness.startWorker(target.slot);
        }

        // Finite failure injection: leave the replacement workers/reaper uninterrupted to prove liveness.
        await harness.until(async () => (
            await prisma.job.count({ where: { runId: created.run.id, status: "completed" } })
        ) === 20, 60_000);
        await harness.stop();
        const jobs = await prisma.job.findMany({
            where: { runId: created.run.id }, include: { evals: true, traces: true },
        });
        const completions = harness.processes.flatMap((process) => process.completions);
        expect(jobs).toHaveLength(20);
        expect(crashes).toHaveLength(4);
        expect(completions).toHaveLength(20);
        for (const job of jobs) {
            expect(job).toMatchObject({
                status: "completed", lockedBy: null, leaseToken: null, leaseExpiresAt: null, error: null,
            });
            expect(job.result).not.toBeNull();
            expect(job.completedAt).not.toBeNull();
            expect(job.attempts).toBeGreaterThanOrEqual(1);
            expect(job.attempts).toBeLessThanOrEqual(job.maxAttempts);
            expect(job.evals).toHaveLength(1);
            expect(job.evals[0].taskCompletionScore).toBe(job.evalScore);
            expect(completions.filter((id) => id === job.id)).toHaveLength(1);
        }
        for (const crash of crashes) {
            const recovered = jobs.find((job) => job.id === crash.id)!;
            expect(recovered.attempts).toBeGreaterThan(1);
            const tokens = new Set(recovered.traces.map((trace) => (
                trace.input as { leaseToken?: string }
            ).leaseToken));
            expect(tokens.has(crash.leaseToken)).toBe(true);
            expect(tokens.size).toBeGreaterThan(1);
        }
        expect(await prisma.providerRateLimit.count()).toBe(1);
        expect(await prisma.trace.count({ where: { stepName: "provider_rate_limit" } })).toBeGreaterThanOrEqual(24);
        expect(harness.processes.filter((process) => process.role === "reaper")[0].logs).toContain("Reaper recovered");
        console.log(`[chaos] ${JSON.stringify({ seed, completed: jobs.length, crashes: crashes.length, evals: 20 })}`);
    } catch (error) {
        await harness.stop();
        throw await diagnostics(harness, error);
    } finally { await harness.stop(); }
}, 90_000);

it("dead-letters an exhausted crashed attempt without accepting a result or evaluation", async () => {
    await loadDataset(await readDatasetFile(retentionV1));
    const datasetCase = await prisma.datasetCase.findFirstOrThrow({ orderBy: { name: "asc" } });
    const job = await prisma.job.create({ data: {
        type: "retention_risk_analysis", caseId: datasetCase.id, maxAttempts: 1,
        input: { userId: "chaos_exhausted", mockConfig: { latencyMs: 750 } },
    } });
    const harness = new ChaosHarness(10_000);
    try {
        harness.startReaper();
        const first = harness.startWorker(0);
        await harness.until(async () => (await activeModelCalls()).some((active) => active.id === job.id));
        expect(await harness.crash(0)).toEqual({ code: null, signal: "SIGKILL" });
        harness.startWorker(0);
        await harness.until(async () => (
            await prisma.job.findUniqueOrThrow({ where: { id: job.id } })
        ).status === "dead_letter");
        await harness.stop();
        expect(await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
            status: "dead_letter", attempts: 1, error: "Worker lease expired",
            lockedBy: null, leaseToken: null, leaseExpiresAt: null, result: null,
            completedAt: expect.any(Date),
        });
        expect(await prisma.eval.count({ where: { jobId: job.id } })).toBe(0);
        expect(first.completions).toEqual([]);
        expect(harness.processes.flatMap((process) => process.completions)).toEqual([]);
        console.log(`[chaos] ${JSON.stringify({ seed, deadLetters: 1, evals: 0 })}`);
    } catch (error) {
        await harness.stop();
        throw await diagnostics(harness, error);
    } finally { await harness.stop(); }
}, 15_000);
