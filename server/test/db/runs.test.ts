import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { loadDataset, readDatasetFile } from "../../src/datasets.js";
import { prisma } from "../../src/db.js";
import { completeJob, createEval } from "../../src/jobs.js";
import { createRun } from "../../src/runs.js";
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

// TODO(ME): implement these. startRun() and finishJob() do the setup: finishJob
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
    // A valid UUID that matches no run.
    it.todo("returns null for an unknown run id");

    // Straight after createRun: 20 queued, status in_progress, passed 0,
    // passRate 0, meanScore and both latencies null, totals 0. Also check
    // run.dataset is { name: "retention", version: 1 }.
    it.todo("reports a fresh run as in_progress with every job queued");

    // e.g. 3 jobs completed with labelCorrect true, 1 completed with false,
    // 1 set to status "failed" (prisma.job.update). passed should be 3 and
    // passRate 3/20.
    it.todo("counts a pass only for completed jobs whose label was correct");

    // Finish a few jobs with different scores/tokens/costs and check the
    // average and sums. Leave others queued: they must not drag the mean down.
    it.todo("computes meanScore, totalTokens and totalCost over completed jobs only");

    // Finish all 20 with latencies 100, 200, ..., 2000. percentile_cont
    // interpolates: p50 = 1050 (between 1000 and 1100), p95 = 1905
    // (5% of the way from 1900 to 2000).
    it.todo("computes p50 and p95 latency with percentile_cont");

    // Finish or fail every job: status flips to "finished". One job still
    // running (prisma.job.update status "running") keeps it "in_progress".
    it.todo("is finished only once no job is queued or running");

    // Give one job two evals (createEval twice: first labelCorrect false,
    // then true, a little later) before completing it. It should count as passed.
    it.todo("uses a job's latest eval when it has more than one");
});
