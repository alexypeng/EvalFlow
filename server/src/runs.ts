import { prisma } from "./db.js";
import type { Run } from "./generated/prisma/client.js";
import { promptVersionExists, resolveLlm } from "./llm.js";
import { AnalyticsSnapshotSchema, type CreateRunInput } from "./types.js";

export type CreateRunResult =
    { ok: true; run: Run; jobCount: number } | { ok: false; reason: "dataset_not_found" | "unknown_prompt_version" };

export async function createRun(input: CreateRunInput): Promise<CreateRunResult> {
    const dataset = await prisma.dataset.findUnique({
        where: { name_version: { name: input.datasetName, version: input.datasetVersion } },
        include: { datasetCases: true },
    });
    if (!dataset) {
        return { ok: false, reason: "dataset_not_found" };
    }

    const validVersion = await promptVersionExists(input.promptVersion);
    if (!validVersion) {
        return { ok: false, reason: "unknown_prompt_version" };
    }

    const { provider, model } = resolveLlm();

    const run = await prisma.$transaction(async (tx) => {
        const run = await tx.run.create({
            data: {
                datasetId: dataset.id,
                promptVersion: input.promptVersion,
                provider: provider,
                model: model,
            },
        });

        await tx.job.createMany({
            data: dataset.datasetCases.map((datasetCase) => {
                const snapshot = AnalyticsSnapshotSchema.parse(datasetCase.snapshot);

                return {
                    type: "retention_risk_analysis",
                    runId: run.id,
                    caseId: datasetCase.id,
                    input: {
                        userId: snapshot.retentionSummary.userId,
                        snapshot,
                        promptVersion: input.promptVersion,
                        expectedRisk: datasetCase.expectedRisk,
                    },
                };
            }),
        });

        return run;
    });

    return { ok: true, run, jobCount: dataset.datasetCases.length };
}

export type RunReport = {
    run: Run & { dataset: { name: string; version: number } };
    // "finished" once no job is queued or running (decided: derived, not stored).
    status: "in_progress" | "finished";
    jobs: { total: number; queued: number; running: number; completed: number; failed: number };
    // A case passes when its job completed and the risk label matched the
    // answer key (decided 2026-10-01). Failed jobs count as not passed.
    passed: number;
    passRate: number; // passed / jobs.total, 0..1
    // Over completed jobs only; null when none have completed yet.
    meanScore: number | null;
    latencyMs: { p50: number | null; p95: number | null };
    totalTokens: number;
    totalCost: number;
};

// TODO(ME): build the report for one run; null if the run doesn't exist.
// - Load the run with its dataset's name and version (include).
// - Count the run's jobs by status. prisma.job.groupBy({ by: ["status"], where: { runId }, _count: true })
//   does it in one query; statuses with no jobs are simply missing from the result.
// - passed: completed jobs whose latest eval has reasonableRiskLabel = true. Each job has one eval
//   per successful attempt, so "latest" = highest createdAt.
// - meanScore / totalTokens / totalCost: prisma.job.aggregate over completed jobs
//   (_avg evalScore, _sum totalTokens and estimatedCost). estimatedCost is a Prisma Decimal: Number() it.
// - latencyMs: Prisma has no percentiles, so use $queryRaw with Postgres:
//     percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)  -- and 0.95 for p95
//   over completed jobs of this run. percentile_cont interpolates, so p95 of 20 values sits
//   between the 19th and 20th. Returns null over zero rows.
export async function getRunReport(runId: string): Promise<RunReport | null> {
    throw new Error("getRunReport is not implemented yet");
}
