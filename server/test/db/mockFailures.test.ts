import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { createRun, compareRuns, getRunReport } from "../../src/runs.js";
import { loadDataset, readDatasetFile } from "../../src/datasets.js";
import { retentionV1, resetDatabase } from "./helpers.js";
import type { MockConfig } from "../../src/types.js";

beforeEach(resetDatabase);

it("runs persisted mock settings through a real worker, retries and comparison", async () => {
    await loadDataset(await readDatasetFile(retentionV1));
    async function run(mockConfig: Partial<MockConfig>, promptVersion = "v2") {
        const result = await createRun({ datasetName: "retention", datasetVersion: 1, promptVersion, mockConfig });
        if (!result.ok) throw new Error("expected createRun to succeed");
        return result.run;
    }
    const baseline = await run({ latencyMs: 5 }, "v1");
    const changed = await run({ wrongLabelRate: 1 });
    const invalid = await run({ invalidJsonRate: 1 });
    const missing = await run({ missingEvidenceRate: 1 });
    await prisma.job.updateMany({
        where: { runId: { in: [invalid.id, missing.id] } }, data: { maxAttempts: 2 },
    });

    const worker = spawn(process.execPath, ["--import", "tsx", "src/worker.ts"], {
        cwd: process.cwd(),
        env: {
            ...process.env, LLM_PROVIDER: "mock", GEMINI_API_KEY: "", WORKER_CONCURRENCY: "4", POLL_INTERVAL_MS: "10",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    worker.stdout.on("data", (data) => { logs = (logs + data.toString()).slice(-2000); });
    worker.stderr.on("data", (data) => { logs = (logs + data.toString()).slice(-2000); });
    const exited = once(worker, "exit");
    try {
        const deadline = Date.now() + 20_000;
        while (await prisma.job.count({ where: { status: { in: ["queued", "running"] } } })) {
            if (worker.exitCode !== null || worker.signalCode !== null || Date.now() > deadline) {
                throw new Error(`Worker did not finish the mock runs: ${logs}`);
            }
            await sleep(25);
        }
        const baseReport = await getRunReport(baseline.id);
        expect(baseReport!.passed).toBe(16);
        expect(baseReport!.latencyMs.p50).toBeGreaterThanOrEqual(5);
        const comparison = await compareRuns(baseline.id, changed.id);
        if (!comparison.ok) throw new Error("expected comparison to succeed");
        expect(comparison.comparison.summary.regression).toBe(16);
        expect(comparison.comparison.baseline.mockConfig).toEqual(baseline.mockConfig);
        expect(comparison.comparison.candidate.mockConfig).toEqual(changed.mockConfig);

        for (const runId of [invalid.id, missing.id]) {
            expect((await getRunReport(runId))!.jobs.failed).toBe(20);
            const jobs = await prisma.job.findMany({ where: { runId }, include: { traces: true, evals: true } });
            for (const job of jobs) {
                expect(job.attempts).toBe(2);
                expect(job.evals).toHaveLength(0);
                const calls = job.traces.filter((trace) => trace.stepName === "llm_call");
                expect(calls).toHaveLength(2);
                expect(calls[0].output).toEqual(calls[1].output);
                expect(calls[0].input).toMatchObject({
                    caseId: job.caseId,
                    mockConfig: runId === invalid.id ? invalid.mockConfig : missing.mockConfig,
                });
            }
        }
    } finally {
        worker.kill("SIGTERM");
        await exited;
    }
}, 30_000);
