import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { loadDataset, readDatasetFile } from "../../src/datasets.js";
import { prisma } from "../../src/db.js";
import { DatasetFileSchema } from "../../src/types.js";
import { resetDatabase } from "./helpers.js";

const retentionV1 = fileURLToPath(
    new URL("../../datasets/retention-v1.json", import.meta.url),
);

beforeEach(resetDatabase);

describe("loadDataset", () => {
    it("loads the retention-v1 dataset file with all its cases", async () => {
        const file = await readDatasetFile(retentionV1);

        const result = await loadDataset(file);

        expect(result.status).toBe("created");
        const cases = await prisma.datasetCase.findMany({
            where: { datasetId: result.datasetId },
        });
        expect(cases).toHaveLength(file.cases.length);
    });

    it("is a no-op when the same version is loaded again unchanged", async () => {
        const file = await readDatasetFile(retentionV1);
        const first = await loadDataset(file);

        const second = await loadDataset(file);

        expect(second).toEqual({
            status: "unchanged",
            datasetId: first.datasetId,
            caseCount: file.cases.length,
        });
        expect(await prisma.dataset.count()).toBe(1);
    });

    it("refuses to change an existing version in place", async () => {
        const file = await readDatasetFile(retentionV1);
        await loadDataset(file);

        const edited = structuredClone(file);
        edited.cases[0].expectedRisk =
            edited.cases[0].expectedRisk === "low" ? "high" : "low";

        await expect(loadDataset(edited)).rejects.toThrow(/bump the version/);
    });
});

describe("DatasetFileSchema", () => {
    it("rejects duplicate case names", async () => {
        const file = await readDatasetFile(retentionV1);
        const duplicated = {
            ...file,
            cases: [file.cases[0], file.cases[0]],
        };

        expect(DatasetFileSchema.safeParse(duplicated).success).toBe(false);
    });
});
