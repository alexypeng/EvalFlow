import { readFile } from "node:fs/promises";
import { z } from "zod";
import { prisma } from "./db.js";
import { DatasetFileSchema, type DatasetFile } from "./types.js";

export async function readDatasetFile(path: string): Promise<DatasetFile> {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    const parsed = DatasetFileSchema.safeParse(raw);

    if (!parsed.success) {
        throw new Error(
            `Invalid dataset file ${path}:\n${z.prettifyError(parsed.error)}`,
        );
    }

    return parsed.data;
}

// Datasets are immutable: editing one in place would change what old runs
// mean. Reloading an existing name+version is a no-op if unchanged, an error
// otherwise.
export async function loadDataset(file: DatasetFile) {
    const existing = await prisma.dataset.findUnique({
        where: { name_version: { name: file.name, version: file.version } },
        include: { datasetCases: true },
    });

    if (existing) {
        assertSameCases(file, existing.datasetCases);

        return {
            status: "unchanged" as const,
            datasetId: existing.id,
            caseCount: existing.datasetCases.length,
        };
    }

    const created = await prisma.dataset.create({
        data: {
            name: file.name,
            version: file.version,
            datasetCases: {
                create: file.cases.map((c) => ({
                    name: c.name,
                    expectedRisk: c.expectedRisk,
                    snapshot: c.snapshot,
                })),
            },
        },
    });

    return {
        status: "created" as const,
        datasetId: created.id,
        caseCount: file.cases.length,
    };
}

function assertSameCases(
    file: DatasetFile,
    stored: Array<{ name: string; expectedRisk: string; snapshot: unknown }>,
) {
    const label = `${file.name} v${file.version}`;
    const storedByName = new Map(stored.map((c) => [c.name, c]));

    if (stored.length !== file.cases.length) {
        throw new Error(
            `Dataset ${label} already exists with ${stored.length} cases, but the file has ${file.cases.length}. Datasets are immutable; bump the version.`,
        );
    }

    for (const fileCase of file.cases) {
        const storedCase = storedByName.get(fileCase.name);
        const same =
            storedCase !== undefined &&
            storedCase.expectedRisk === fileCase.expectedRisk &&
            canonicalJson(storedCase.snapshot) ===
                canonicalJson(fileCase.snapshot);

        if (!same) {
            throw new Error(
                `Dataset ${label} already exists and case "${fileCase.name}" differs from the file. Datasets are immutable; bump the version.`,
            );
        }
    }
}

// Postgres jsonb doesn't keep object key order, so compare with sorted keys.
function canonicalJson(value: unknown): string {
    return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [
                    key,
                    sortKeys((value as Record<string, unknown>)[key]),
                ]),
        );
    }

    return value;
}
