import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { loadDataset, readDatasetFile } from "../../src/datasets.js";
import { prisma } from "../../src/db.js";
import { createRun } from "../../src/runs.js";
import { resetDatabase } from "./helpers.js";

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
    it.todo("never includes the case's expectedRisk in the prompt");
});
