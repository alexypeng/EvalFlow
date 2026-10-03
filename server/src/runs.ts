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

export async function compareRuns(baselineId: string, candidateId: string): Promise<CompareRunsResult> {
    const [baselineWithDataset, candidate] = await Promise.all([
        prisma.run.findUnique({ where: { id: baselineId }, include: { dataset: true } }),
        prisma.run.findUnique({ where: { id: candidateId } }),
    ]);

    if (!baselineWithDataset || !candidate) {
        return { ok: false, reason: "run_not_found" };
    }

    // Different datasets means different questions: there is nothing to pair up.
    if (baselineWithDataset.datasetId !== candidate.datasetId) {
        return { ok: false, reason: "different_datasets" };
    }

    const { dataset, ...baseline } = baselineWithDataset;

    const [cases, baselineSides, candidateSides] = await Promise.all([
        prisma.datasetCase.findMany({ where: { datasetId: dataset.id }, select: { id: true, name: true } }),
        sidesByCase(baseline.id),
        sidesByCase(candidate.id),
    ]);

    // Sorted in code, not SQL: Postgres collation can order "_" differently from JavaScript.
    cases.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const summary: Record<CaseChange, number> = { regression: 0, improvement: 0, warning: 0, unchanged: 0, pending: 0 };

    const rows = cases.map((datasetCase) => {
        const baselineSide = baselineSides.get(datasetCase.id) ?? noJob;
        const candidateSide = candidateSides.get(datasetCase.id) ?? noJob;
        const change = classifyChange(baselineSide, candidateSide);

        summary[change] += 1;

        return {
            caseId: datasetCase.id,
            caseName: datasetCase.name,
            baseline: baselineSide,
            candidate: candidateSide,
            change,
        };
    });

    return {
        ok: true,
        comparison: {
            baseline,
            candidate,
            dataset: { name: dataset.name, version: dataset.version },
            cases: rows,
            summary,
        },
    };
}

// createRun makes a job for every case in one transaction, so this shouldn't
// happen; if it does, the case can't be judged.
const noJob: RunSide = { outcome: "pending", score: null };

// Every job of one run, keyed by its case, so the other run's jobs can be
// matched in one lookup instead of a search.
async function sidesByCase(runId: string) {
    const jobs = await prisma.job.findMany({
        where: { runId },
        select: {
            caseId: true,
            status: true,
            evalScore: true,
            evals: {
                orderBy: { createdAt: "desc" },
                take: 1,
                select: { reasonableRiskLabel: true },
            },
        },
    });

    const sides = new Map<string, RunSide>();

    for (const job of jobs) {
        if (job.caseId) {
            sides.set(job.caseId, { outcome: caseOutcome(job), score: job.evalScore });
        }
    }

    return sides;
}

function caseOutcome(job: { status: string; evals: Array<{ reasonableRiskLabel: boolean }> }): CaseOutcome {
    if (job.status === "queued" || job.status === "running") {
        return "pending";
    }

    // Same rule as the run report: completed with the right label. A failed job
    // produced no usable answer, so it fails.
    return job.status === "completed" && job.evals[0]?.reasonableRiskLabel === true ? "pass" : "fail";
}

function classifyChange(baseline: RunSide, candidate: RunSide): CaseChange {
    // Checked first: otherwise an unfinished case falls through every rule below
    // and is reported as "unchanged", hiding that it was never judged.
    if (baseline.outcome === "pending" || candidate.outcome === "pending") {
        return "pending";
    }

    if (baseline.outcome === "pass" && candidate.outcome === "fail") {
        return "regression";
    }

    if (baseline.outcome === "fail" && candidate.outcome === "pass") {
        return "improvement";
    }

    // Scores move in steps of 20, so any drop means at least one check now fails.
    if (baseline.outcome === "pass" && candidate.outcome === "pass" && (candidate.score ?? 0) < (baseline.score ?? 0)) {
        return "warning";
    }

    return "unchanged";
}
