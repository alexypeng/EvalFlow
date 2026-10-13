import { beforeEach, describe, expect, it } from "vitest";
import { loadDataset, readDatasetFile } from "../../src/datasets.js";
import { createRun, compareRuns } from "../../src/runs.js";
import { prisma } from "../../src/db.js";
import { finishJob, jobForCase, resetDatabase, retentionV1, startRun } from "./helpers.js";

const unknownRunId = "00000000-0000-0000-0000-000000000000";

beforeEach(resetDatabase);

// Finishes one case's job in a run: "pass" = right label, "fail" = wrong label.
async function settle(
    runId: string,
    caseName: string,
    outcome: "pass" | "fail",
    score = outcome === "pass" ? 100 : 80,
) {
    const job = await jobForCase(runId, caseName);
    await finishJob(job.id, { labelCorrect: outcome === "pass", score, latencyMs: 10 });
}

async function compare(baselineId: string, candidateId: string) {
    const result = await compareRuns(baselineId, candidateId);
    if (!result.ok) throw new Error(`expected compareRuns to succeed, got ${result.reason}`);
    return result.comparison;
}

function row(comparison: Awaited<ReturnType<typeof compare>>, caseName: string) {
    const found = comparison.cases.find((c) => c.caseName === caseName);
    if (!found) throw new Error(`no row for case "${caseName}"`);
    return found;
}

describe("compareRuns", () => {
    it("returns run_not_found when either run doesn't exist", async () => {
        const { run } = await startRun();

        expect(await compareRuns(unknownRunId, run.id)).toEqual({ ok: false, reason: "run_not_found" });
        expect(await compareRuns(run.id, unknownRunId)).toEqual({ ok: false, reason: "run_not_found" });
    });

    it("returns different_datasets for runs of different datasets", async () => {
        const { run: v1Run } = await startRun();
        await loadDataset({ ...(await readDatasetFile(retentionV1)), version: 2 });
        const v2 = await createRun({ datasetName: "retention", datasetVersion: 2, promptVersion: "v1" });
        if (!v2.ok) throw new Error("expected createRun to succeed");

        expect(await compareRuns(v1Run.id, v2.run.id)).toEqual({ ok: false, reason: "different_datasets" });
    });

    it("returns one row per case, sorted by case name", async () => {
        const { run: baseline } = await startRun();
        const { run: candidate } = await startRun();

        const comparison = await compare(baseline.id, candidate.id);
        const names = comparison.cases.map((c) => c.caseName);

        expect(names).toHaveLength(20);
        expect(names).toEqual([...names].sort());
        expect(new Set(names).size).toBe(20);
        expect(comparison.dataset).toEqual({ name: "retention", version: 1 });
    });

    it("marks pass -> fail as a regression", async () => {
        const { run: baseline } = await startRun();
        const { run: candidate } = await startRun();
        await settle(baseline.id, "boundary_nps_5", "pass");
        await settle(candidate.id, "boundary_nps_5", "fail");

        const comparison = await compare(baseline.id, candidate.id);

        expect(row(comparison, "boundary_nps_5")).toMatchObject({
            baseline: { outcome: "pass", score: 100 },
            candidate: { outcome: "fail", score: 80 },
            change: "regression",
        });
    });

    it("marks fail -> pass as an improvement", async () => {
        const { run: baseline } = await startRun();
        const { run: candidate } = await startRun();
        await settle(baseline.id, "judgment_cancellation_scheduled", "fail");
        await settle(candidate.id, "judgment_cancellation_scheduled", "pass");

        const comparison = await compare(baseline.id, candidate.id);

        expect(row(comparison, "judgment_cancellation_scheduled").change).toBe("improvement");
    });

    it("marks a lower score that still passes as a warning, an equal one as unchanged", async () => {
        const { run: baseline } = await startRun();
        const { run: candidate } = await startRun();
        await settle(baseline.id, "boundary_drop_10", "pass", 100);
        await settle(candidate.id, "boundary_drop_10", "pass", 80);
        await settle(baseline.id, "healthy_power_user", "pass", 100);
        await settle(candidate.id, "healthy_power_user", "pass", 100);

        const comparison = await compare(baseline.id, candidate.id);

        expect(row(comparison, "boundary_drop_10").change).toBe("warning");
        expect(row(comparison, "healthy_power_user").change).toBe("unchanged");
    });

    it("treats a failed job as a fail", async () => {
        const { run: baseline } = await startRun();
        const { run: candidate } = await startRun();
        await settle(baseline.id, "boundary_nps_7", "pass");
        const crashed = await jobForCase(candidate.id, "boundary_nps_7");
        await prisma.job.update({ where: { id: crashed.id }, data: { status: "failed" } });

        const comparison = await compare(baseline.id, candidate.id);

        expect(row(comparison, "boundary_nps_7")).toMatchObject({
            candidate: { outcome: "fail", score: null },
            change: "regression",
        });
    });

    it("marks a case pending while either job is unfinished", async () => {
        const { run: baseline } = await startRun();
        const { run: candidate } = await startRun();
        await settle(baseline.id, "boundary_drop_4", "pass");

        const comparison = await compare(baseline.id, candidate.id);

        expect(row(comparison, "boundary_drop_4")).toMatchObject({
            baseline: { outcome: "pass" },
            candidate: { outcome: "pending" },
            change: "pending",
        });
    });

    it("summarises the number of cases in each category", async () => {
        const { run: baseline } = await startRun();
        const { run: candidate } = await startRun();
        await settle(baseline.id, "boundary_nps_5", "pass");
        await settle(candidate.id, "boundary_nps_5", "fail");
        await settle(baseline.id, "judgment_gone_quiet", "fail");
        await settle(candidate.id, "judgment_gone_quiet", "pass");
        await settle(baseline.id, "boundary_drop_9", "pass", 100);
        await settle(candidate.id, "boundary_drop_9", "pass", 60);
        await settle(baseline.id, "healthy_power_user", "pass");
        await settle(candidate.id, "healthy_power_user", "pass");

        const comparison = await compare(baseline.id, candidate.id);

        expect(comparison.summary).toEqual({ regression: 1, improvement: 1, warning: 1, unchanged: 1, pending: 16 });

        // The summary must agree with the rows it summarises.
        for (const [change, count] of Object.entries(comparison.summary)) {
            expect(comparison.cases.filter((c) => c.change === change)).toHaveLength(count);
        }
    });
});
