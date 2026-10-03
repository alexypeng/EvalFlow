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
    const run = await prisma.run.findUnique({
        where: { id: runId },
        include: { dataset: { select: { name: true, version: true } } },
    });

    if (!run) {
        return null;
    }

    const statusCounts = await prisma.job.groupBy({
        by: ["status"],
        where: { runId },
        _count: true,
    });

    const jobs = { total: 0, queued: 0, running: 0, completed: 0, failed: 0 };

    for (const entry of statusCounts) {
        jobs[entry.status] = entry._count;
        jobs.total += entry._count;
    }

    const status = jobs.queued + jobs.running === 0 ? "finished" : "in_progress";

    const completedJobs = await prisma.job.findMany({
        where: { runId, status: "completed" },
        select: {
            evals: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: { reasonableRiskLabel: true },
            },
        },
    });

    const passed = completedJobs.filter((job) => job.evals[0]?.reasonableRiskLabel === true).length;
    const passRate = jobs.total === 0 ? 0 : passed / jobs.total;

    const totals = await prisma.job.aggregate({
        where: { runId, status: "completed" },
        _avg: { evalScore: true },
        _sum: { totalTokens: true, estimatedCost: true },
    });

    const meanScore = totals._avg.evalScore;
    const totalTokens = totals._sum.totalTokens ?? 0;
    const totalCost = totals._sum.estimatedCost?.toNumber() ?? 0;

    const [latency] = await prisma.$queryRaw<Array<{ p50: number | null; p95: number | null }>>`
        SELECT
            percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
        FROM jobs
        WHERE run_id = ${runId}::uuid AND status = 'completed'
    `;

    return {
        run,
        status,
        jobs,
        passed,
        passRate,
        meanScore,
        latencyMs: { p50: latency.p50, p95: latency.p95 },
        totalTokens,
        totalCost,
    };
}

// pass: job completed and its latest eval had the right label. fail: completed
// with the wrong label, or failed. pending: still queued or running.
export type CaseOutcome = "pass" | "fail" | "pending";

// regression: pass -> fail. improvement: fail -> pass. warning: pass -> pass
// with a lower score. pending: either side not finished. unchanged: otherwise.
export type CaseChange = "regression" | "improvement" | "warning" | "unchanged" | "pending";

type RunSide = { outcome: CaseOutcome; score: number | null };

export type RunComparison = {
    baseline: Run;
    candidate: Run;
    dataset: { name: string; version: number };
    // One row per dataset case, sorted by case name.
    cases: Array<{ caseId: string; caseName: string; baseline: RunSide; candidate: RunSide; change: CaseChange }>;
    summary: Record<CaseChange, number>;
};

export type CompareRunsResult =
    { ok: true; comparison: RunComparison } | { ok: false; reason: "run_not_found" | "different_datasets" };

// TODO(ME): compare two runs of the same dataset, case by case.
// - Load both runs. Either missing -> run_not_found. Different datasetId -> different_datasets
//   (comparing different questions is meaningless).
// - For each run, get every job's caseId, status, evalScore and latest eval's reasonableRiskLabel
//   (same findMany + evals orderBy/take as getRunReport, without the status filter).
// - Work out each job's CaseOutcome. A failed job is "fail": it produced no usable answer.
// - Pair the two runs' jobs by caseId (a Map from caseId to job makes this easy) and classify each
//   pair into a CaseChange. Check "pending" first: an unfinished case can't be judged yet.
// - Case names come from the dataset's cases (prisma.datasetCase.findMany for the datasetId).
// - summary: how many cases fall into each CaseChange (start every count at 0).
export async function compareRuns(baselineId: string, candidateId: string): Promise<CompareRunsResult> {
    throw new Error("compareRuns is not implemented yet");
}
