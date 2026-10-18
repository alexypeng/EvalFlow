import { readFileSync } from "node:fs";
import { beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDatabase } from "./helpers.js";

// Exercise the exact SQL shipped to KEDA, rather than a second implementation.
const query = readFileSync(new URL("../../../deploy/helm/evalflow-app/files/worker-demand.sql", import.meta.url), "utf8");
const demand = async () => Number((await prisma.$queryRawUnsafe<{ count: bigint }[]>(query))[0].count);
beforeEach(resetDatabase);

it("counts eligible queued and running jobs, excluding delayed and terminal jobs", async () => {
    expect(await demand()).toBe(0);
    await prisma.job.createMany({
        data: ([
            { status: "queued", runAfter: new Date(0) },
            { status: "queued", runAfter: new Date("2099-01-01") },
            { status: "running", runAfter: new Date("2099-01-01") },
            { status: "completed", runAfter: new Date(0) },
            { status: "dead_letter", runAfter: new Date(0) },
        ] as const).map((job) => ({ type: "retention_risk_analysis", input: {}, ...job })),
    });
    expect(await demand()).toBe(2);
});

it("starts counting a delayed retry when it becomes eligible without changing its status", async () => {
    const job = await prisma.job.create({
        data: { type: "retention_risk_analysis", input: {}, attempts: 1, runAfter: new Date("2099-01-01") },
    });
    expect(await demand()).toBe(0);
    await prisma.$executeRaw`UPDATE jobs SET run_after = CURRENT_TIMESTAMP WHERE id = ${job.id}::uuid`;
    expect(await demand()).toBe(1);
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("queued");
});
