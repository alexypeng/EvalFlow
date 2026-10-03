import { fileURLToPath } from "node:url";
import { loadDataset, readDatasetFile } from "../../src/datasets.js";
import { prisma } from "../../src/db.js";
import { completeJob, createEval } from "../../src/jobs.js";
import { createRun } from "../../src/runs.js";

export const retentionV1 = fileURLToPath(new URL("../../datasets/retention-v1.json", import.meta.url));

// traces and evals cascade from jobs.
export async function resetDatabase() {
    await prisma.$executeRawUnsafe("TRUNCATE TABLE jobs, runs, dataset_cases, datasets CASCADE");
}

// Loads retention v1 (a no-op if already loaded) and starts a run of it.
export async function startRun(promptVersion = "v1") {
    await loadDataset(await readDatasetFile(retentionV1));
    const result = await createRun({ datasetName: "retention", datasetVersion: 1, promptVersion });
    if (!result.ok) throw new Error("expected createRun to succeed");

    const jobs = await prisma.job.findMany({ where: { runId: result.run.id }, orderBy: { id: "asc" } });
    return { run: result.run, jobs };
}

// Stands in for the worker: grades and completes a job with a chosen outcome.
export async function finishJob(
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

// A run's job for one dataset case, e.g. jobForCase(run.id, "boundary_nps_4").
export async function jobForCase(runId: string, caseName: string) {
    const job = await prisma.job.findFirst({ where: { runId, datasetCase: { name: caseName } } });
    if (!job) throw new Error(`no job for case "${caseName}" in run ${runId}`);
    return job;
}
