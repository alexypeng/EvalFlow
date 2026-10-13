import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRunBaseline } from "../../src/runs.js";
import { prisma } from "../../src/db.js";
import { finishJob, resetDatabase, startRun } from "./helpers.js";

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllEnvs());

async function finishAll(jobs: Array<{ id: string }>) {
    for (const job of jobs) await finishJob(job.id, { labelCorrect: true, score: 100, latencyMs: 10 });
}
async function exported(runId: string) {
    const result = await getRunBaseline(runId);
    if (!result.ok) throw new Error(result.reason);
    return result.baseline;
}

describe("getRunBaseline", () => {
    it("returns not found for an unknown run", async () => {
        expect(await getRunBaseline("00000000-0000-4000-8000-000000000001"))
            .toEqual({ ok: false, reason: "run_not_found" });
    });

    it("rejects queued/running cases and missing jobs", async () => {
        const { run, jobs } = await startRun();
        expect(await getRunBaseline(run.id)).toEqual({ ok: false, reason: "run_not_finished" });
        await finishAll(jobs.slice(1));
        await prisma.job.update({ where: { id: jobs[0].id }, data: { status: "running" } });
        expect(await getRunBaseline(run.id)).toEqual({ ok: false, reason: "run_not_finished" });
        await prisma.job.delete({ where: { id: jobs[0].id } });
        expect(await getRunBaseline(run.id)).toEqual({ ok: false, reason: "run_not_finished" });
    });

    it("exports sorted terminal outcomes, scores and saved settings without database IDs", async () => {
        const { run, jobs } = await startRun("v2");
        await finishAll(jobs.slice(2));
        await finishJob(jobs[0].id, { labelCorrect: false, score: 80, latencyMs: 10 });
        await prisma.job.update({ where: { id: jobs[1].id }, data: { status: "failed" } });
        const baseline = await exported(run.id);
        expect(baseline.dataset).toEqual({ name: "retention", version: 1 });
        expect(baseline.run).toEqual({
            promptVersion: "v2", provider: "mock", model: "mock-rule-based",
            mockConfig: {
                seed: "evalflow", wrongLabelRate: 0, invalidJsonRate: 0, missingEvidenceRate: 0, latencyMs: 0,
            },
        });
        expect(baseline.formatVersion).toBe(1);
        expect(baseline.cases).toHaveLength(20);
        expect(baseline.cases.map((item) => item.caseName))
            .toEqual(baseline.cases.map((item) => item.caseName).sort());
        expect(baseline.cases.filter((item) => item.outcome === "pass")).toHaveLength(18);
        expect(baseline.cases.filter((item) => item.outcome === "fail").map((item) => item.score).sort())
            .toEqual([80, null].sort());
        expect(JSON.stringify(baseline)).not.toContain(run.id);
        expect(Object.keys(baseline.cases[0]).sort()).toEqual(["caseName", "outcome", "score"]);
    });

    it("uses the latest evaluation when an earlier result differs", async () => {
        const { run, jobs } = await startRun();
        await finishAll(jobs);
        const earlier = await prisma.eval.findFirstOrThrow({ where: { jobId: jobs[0].id } });
        await prisma.eval.update({ where: { id: earlier.id }, data: { createdAt: new Date(0) } });
        await finishJob(jobs[0].id, { labelCorrect: false, score: 80, latencyMs: 10 });
        expect((await exported(run.id)).cases.filter((item) => item.outcome === "fail")).toHaveLength(1);
    });

    it("produces the same baseline after reloading into a fresh database with new case IDs", async () => {
        const first = await startRun();
        await finishAll(first.jobs);
        const baseline = await exported(first.run.id);
        await resetDatabase();
        const second = await startRun();
        expect(second.jobs[0].caseId).not.toBe(first.jobs[0].caseId);
        await finishAll(second.jobs);
        expect(await exported(second.run.id)).toEqual(baseline);
    });

    it("exports Gemini metadata without mock settings", async () => {
        vi.stubEnv("LLM_PROVIDER", "gemini");
        vi.stubEnv("GEMINI_API_KEY", "test-key");
        const { run, jobs } = await startRun();
        await finishAll(jobs);
        const baseline = await exported(run.id);
        expect(baseline.run.provider).toBe("gemini");
        expect(baseline.run).not.toHaveProperty("mockConfig");
    });
});
