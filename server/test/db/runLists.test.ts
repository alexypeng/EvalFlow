import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { listDatasets, loadDataset, readDatasetFile } from "../../src/datasets.js";
import { getRunReport, listRuns } from "../../src/runs.js";
import { finishJob, resetDatabase, retentionV1, startRun } from "./helpers.js";

beforeEach(resetDatabase);

describe("dashboard lists", () => {
    it("returns empty lists before datasets or runs exist", async () => {
        expect(await listDatasets()).toEqual([]);
        expect(await listRuns()).toEqual([]);
    });

    it("lists dataset versions with case counts and without snapshots or answer keys", async () => {
        const fixture = await readDatasetFile(retentionV1);
        await loadDataset(fixture);
        await loadDataset({ ...fixture, version: 2, cases: fixture.cases.slice(0, 3) });
        const datasets = await listDatasets();
        expect(datasets).toEqual([
            { id: expect.any(String), name: "retention", version: 2, caseCount: 3 },
            { id: expect.any(String), name: "retention", version: 1, caseCount: 20 },
        ]);
    });

    it("matches individual reports across mixed statuses, latest evals and completion metrics", async () => {
        const { run, jobs } = await startRun();
        await finishJob(jobs[0].id, { labelCorrect: true, score: 100, latencyMs: 100, tokens: 30, cost: 0.01 });
        await finishJob(jobs[1].id, { labelCorrect: false, score: 80, latencyMs: 300, tokens: 70, cost: 0.03 });
        await prisma.eval.create({
            data: {
                jobId: jobs[1].id,
                validJson: true,
                hasRequiredFields: true,
                evidenceIncluded: true,
                evidenceSupported: true,
                reasonableRiskLabel: true,
                taskCompletionScore: 100,
                createdAt: new Date(Date.now() - 60_000),
            },
        });
        // Failed/running jobs can retain old metrics or evals; those must not count as completed results.
        await finishJob(jobs[2].id, { labelCorrect: true, score: 100, latencyMs: 900, tokens: 999, cost: 1 });
        await prisma.job.update({ where: { id: jobs[2].id }, data: { status: "failed" } });
        await prisma.job.update({ where: { id: jobs[3].id }, data: { status: "running" } });
        const [listed] = await listRuns();
        expect(listed).toEqual(await getRunReport(run.id));
        expect(listed).toMatchObject({
            status: "in_progress",
            jobs: { total: 20, completed: 2, failed: 1, running: 1, queued: 16 },
            passed: 1, passRate: 0.05, meanScore: 90, totalTokens: 100,
            latencyMs: { p50: 200, p95: 290 },
        });
        expect(listed.totalCost).toBeCloseTo(0.04);
    });

    it("returns newest runs first and limits the page without merging different runs", async () => {
        const { run: older, jobs } = await startRun("v1");
        const { run: newer } = await startRun("v2");
        await prisma.run.update({ where: { id: older.id }, data: { createdAt: new Date("2026-10-01T00:00:00Z") } });
        await finishJob(jobs[0].id, { labelCorrect: true, score: 100, latencyMs: 10 });
        const limited = await listRuns(1);
        expect(limited.map((report) => report.run.id)).toEqual([newer.id]);
        expect(limited[0].passed).toBe(0);
        expect((await listRuns()).map((report) => report.run.id)).toEqual([newer.id, older.id]);
    });

    it("reports terminal-only runs as finished and handles runs with no jobs", async () => {
        const { run } = await startRun();
        await prisma.job.updateMany({ where: { runId: run.id }, data: { status: "failed" } });
        expect((await listRuns())[0]).toEqual(await getRunReport(run.id));
        expect((await listRuns())[0].status).toBe("finished");
        await prisma.job.deleteMany({ where: { runId: run.id } });
        expect((await listRuns())[0]).toEqual(await getRunReport(run.id));
        expect((await listRuns())[0]).toMatchObject({ jobs: { total: 0 }, passed: 0, passRate: 0, meanScore: null });
    });
});
