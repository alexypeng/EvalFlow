import { snapshot } from "node:test";
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
