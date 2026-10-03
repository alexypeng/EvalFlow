import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { loadDataset, readDatasetFile } from "../../src/datasets.js";
import { prisma } from "../../src/db.js";
import { completeJob, createEval } from "../../src/jobs.js";
import { createRun, getRunReport } from "../../src/runs.js";
import { resetDatabase } from "./helpers.js";
import { JobInputSchema } from "../../src/types.js";
import { buildRetentionPrompt } from "../../src/llm.js";

const retentionV1 = fileURLToPath(new URL("../../datasets/retention-v1.json", import.meta.url));

beforeEach(resetDatabase);

describe("createRun", () => {
    it("creates one queued job per case, linked by runId and caseId", async () => {
        await loadDataset(await readDatasetFile(retentionV1));

        const result = await createRun({
            datasetName: "retention",
            datasetVersion: 1,
            promptVersion: "v1",
        });

        if (!result.ok) throw new Error("expected createRun to succeed");

        const jobs = await prisma.job.findMany({ where: { runId: result.run.id } });
        expect(jobs).toHaveLength(20);

        const caseIds = new Set(jobs.map((job) => job.caseId));
        expect(caseIds.size).toBe(20);

        for (const job of jobs) {
            expect(job.status).toBe("queued");
            expect(job.caseId).not.toBeNull();
        }
    });

    it("puts userId, snapshot, promptVersion and expectedRisk in each job's input", async () => {
        await loadDataset(await readDatasetFile(retentionV1));

        const result = await createRun({
            datasetName: "retention",
            datasetVersion: 1,
            promptVersion: "v1",
        });

        if (!result.ok) throw new Error("expected createRun to succeed");

        const dsCase = await prisma.datasetCase.findFirst({ where: { name: "boundary_nps_4" } });
        const job = await prisma.job.findFirst({ where: { runId: result.run.id, caseId: dsCase!.id } });

        expect(job!.input).toEqual({
            userId: "case_boundary_nps_4",
            snapshot: dsCase!.snapshot,
            promptVersion: "v1",
            expectedRisk: "high",
        });
    });

    it("records promptVersion, provider and model on the run", async () => {
        await loadDataset(await readDatasetFile(retentionV1));

        const result = await createRun({
            datasetName: "retention",
            datasetVersion: 1,
            promptVersion: "v1",
        });

        if (!result.ok) throw new Error("expected createRun to succeed");

        const run = await prisma.run.findUnique({ where: { id: result.run.id } });

        expect(run!.promptVersion).toBe("v1");
        expect(run!.provider).toBe("mock");
        expect(run!.model).toBe("mock-rule-based");
    });

    it("returns dataset_not_found and creates nothing for an unknown dataset", async () => {
        await loadDataset(await readDatasetFile(retentionV1));

        const result = await createRun({
            datasetName: "retention",
            datasetVersion: 99,
            promptVersion: "v1",
        });

        expect(result).toEqual({ ok: false, reason: "dataset_not_found" });

        const runCount = await prisma.run.count();
        expect(runCount).toBe(0);

        const jobCount = await prisma.job.count();
        expect(jobCount).toBe(0);
    });

    it("returns unknown_prompt_version and creates nothing for a missing prompt file", async () => {
        await loadDataset(await readDatasetFile(retentionV1));

        const result = await createRun({
            datasetName: "retention",
            datasetVersion: 1,
            promptVersion: "v99",
        });

        expect(result).toEqual({ ok: false, reason: "unknown_prompt_version" });

        const runCount = await prisma.run.count();
        expect(runCount).toBe(0);

        const jobCount = await prisma.job.count();
        expect(jobCount).toBe(0);
    });

    it("creates no run if a job insert fails (transaction rolls back)", async () => {
        await loadDataset(await readDatasetFile(retentionV1));

        await prisma.datasetCase.updateMany({
            where: { name: "boundary_nps_4" },
            data: { snapshot: { broken: true } },
        });

        await expect(
            createRun({
                datasetName: "retention",
                datasetVersion: 1,
                promptVersion: "v1",
            }),
        ).rejects.toThrow();

        const runCount = await prisma.run.count();
        expect(runCount).toBe(0);

        const jobCount = await prisma.job.count();
        expect(jobCount).toBe(0);
    });
});

describe("buildRetentionPrompt", () => {
    it("never includes the case's expectedRisk in the prompt", async () => {
        await loadDataset(await readDatasetFile(retentionV1));

        const result = await createRun({
            datasetName: "retention",
            datasetVersion: 1,
            promptVersion: "v1",
        });

        if (!result.ok) throw new Error("expected createRun to succeed");

        const job = await prisma.job.findFirst({ where: { runId: result.run.id } });
        const parsed = JobInputSchema.parse(job!.input);

        const prompt = await buildRetentionPrompt(parsed.userId, parsed.snapshot!, parsed.promptVersion);

        expect(prompt).not.toContain("expectedRisk");
    });
});

// startRun() and finishJob() do the setup for the report tests: finishJob
// stands in for the worker, so each test decides exactly which jobs completed,
// with what score, latency and label correctness.

async function startRun() {
    await loadDataset(await readDatasetFile(retentionV1));
    const result = await createRun({ datasetName: "retention", datasetVersion: 1, promptVersion: "v1" });
    if (!result.ok) throw new Error("expected createRun to succeed");

    const jobs = await prisma.job.findMany({ where: { runId: result.run.id }, orderBy: { id: "asc" } });
    return { run: result.run, jobs };
}

async function finishJob(
    jobId: string,
    outcome: { labelCorrect: boolean; score: number; latencyMs: number; tokens?: number; cost?: number },
) {
    await createEval({
        jobId,
        validJson: true,
        hasRequiredFields: true,
        evidenceIncluded: true,
        evidenceSupported: true,
        reasonableRiskLabel: outcome.labelCorrect,
        taskCompletionScore: outcome.score,
        notes: "test",
    });
    await completeJob({
        id: jobId,
        result: {},
        latencyMs: outcome.latencyMs,
        promptTokens: 0,
        completionTokens: outcome.tokens ?? 0,
        totalTokens: outcome.tokens ?? 0,
        estimatedCost: outcome.cost ?? 0,
        evalScore: outcome.score,
    });
}

describe("getRunReport", () => {
    it("returns null for an unknown run id", async () => {
        const report = await getRunReport("00000000-0000-0000-0000-000000000000");

        expect(report).toBeNull();
    });

    it("reports a fresh run as in_progress with every job queued", async () => {
        const { run } = await startRun();

        const report = await getRunReport(run.id);

        expect(report).toMatchObject({
            status: "in_progress",
            jobs: { total: 20, queued: 20, running: 0, completed: 0, failed: 0 },
            passed: 0,
            passRate: 0,
            meanScore: null,
            latencyMs: { p50: null, p95: null },
            totalTokens: 0,
            totalCost: 0,
        });
        expect(report!.run.dataset).toEqual({ name: "retention", version: 1 });
    });

    it("counts a pass only for completed jobs whose label was correct", async () => {
        const { run, jobs } = await startRun();

        for (const job of jobs.slice(0, 3)) {
            await finishJob(job.id, { labelCorrect: true, score: 100, latencyMs: 10 });
        }
        await finishJob(jobs[3].id, { labelCorrect: false, score: 80, latencyMs: 10 });
        await prisma.job.update({ where: { id: jobs[4].id }, data: { status: "failed" } });

        const report = await getRunReport(run.id);

        expect(report!.jobs).toEqual({ total: 20, queued: 15, running: 0, completed: 4, failed: 1 });
        expect(report!.passed).toBe(3);
        expect(report!.passRate).toBe(3 / 20);
    });

    it("computes meanScore, totalTokens and totalCost over completed jobs only", async () => {
        const { run, jobs } = await startRun();

        await finishJob(jobs[0].id, { labelCorrect: true, score: 100, latencyMs: 10, tokens: 100, cost: 0.01 });
        await finishJob(jobs[1].id, { labelCorrect: true, score: 80, latencyMs: 10, tokens: 200, cost: 0.02 });
        await finishJob(jobs[2].id, { labelCorrect: false, score: 60, latencyMs: 10, tokens: 300, cost: 0.03 });

        const report = await getRunReport(run.id);

        // The other 17 jobs are still queued; counting them would drag the mean to 12.
        expect(report!.meanScore).toBe(80);
        expect(report!.totalTokens).toBe(600);
        expect(report!.totalCost).toBeCloseTo(0.06);
    });

    it("computes p50 and p95 latency with percentile_cont", async () => {
        const { run, jobs } = await startRun();

        for (const [index, job] of jobs.entries()) {
            await finishJob(job.id, { labelCorrect: true, score: 100, latencyMs: (index + 1) * 100 });
        }

        const report = await getRunReport(run.id);

        // Latencies are 100..2000. p50 sits halfway between the 10th and 11th
        // (1000, 1100); p95 sits 5% of the way from the 19th to the 20th.
        expect(report!.latencyMs.p50).toBeCloseTo(1050);
        expect(report!.latencyMs.p95).toBeCloseTo(1905);
    });

    it("is finished only once no job is queued or running", async () => {
        const { run, jobs } = await startRun();
        const [last, ...rest] = jobs;

        for (const job of rest) {
            await finishJob(job.id, { labelCorrect: true, score: 100, latencyMs: 10 });
        }
        await prisma.job.update({ where: { id: last.id }, data: { status: "running" } });

        expect((await getRunReport(run.id))!.status).toBe("in_progress");

        await prisma.job.update({ where: { id: last.id }, data: { status: "failed" } });

        expect((await getRunReport(run.id))!.status).toBe("finished");
    });

    // Each scenario is in its own test: combined, "wrong then right" and "right
    // then wrong" cancel out (1 pass whichever eval is read), so the count could
    // not tell latest from oldest.
    it("passes a job that was wrong on an earlier attempt and right on the latest", async () => {
        const { run, jobs } = await startRun();

        await prisma.eval.create({ data: { ...olderEval(jobs[0].id, false), createdAt: minuteAgo() } });
        await finishJob(jobs[0].id, { labelCorrect: true, score: 100, latencyMs: 10 });

        expect((await getRunReport(run.id))!.passed).toBe(1);
    });

    it("fails a job that was right on an earlier attempt and wrong on the latest", async () => {
        const { run, jobs } = await startRun();

        await prisma.eval.create({ data: { ...olderEval(jobs[0].id, true), createdAt: minuteAgo() } });
        await finishJob(jobs[0].id, { labelCorrect: false, score: 80, latencyMs: 10 });

        expect((await getRunReport(run.id))!.passed).toBe(0);
    });
});

function minuteAgo() {
    return new Date(Date.now() - 60_000);
}

// An eval from an earlier attempt. Its createdAt is set explicitly in the test,
// so "latest" can't be decided by a timestamp tie.
function olderEval(jobId: string, labelCorrect: boolean) {
    return {
        jobId,
        validJson: true,
        hasRequiredFields: true,
        evidenceIncluded: true,
        evidenceSupported: true,
        reasonableRiskLabel: labelCorrect,
        taskCompletionScore: labelCorrect ? 100 : 80,
        notes: "earlier attempt",
    };
}
