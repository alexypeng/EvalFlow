import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeEach, expect, it } from "vitest";
import { context } from "@opentelemetry/api";
import { prisma } from "../../src/db.js";
import { claimNextJob, createJob, failOrRetryJob, reapExpiredJobs, retryJob } from "../../src/jobs.js";
import { createRun } from "../../src/runs.js";
import { jobParentContext } from "../../src/jobTracing.js";
import { loadDataset, readDatasetFile } from "../../src/datasets.js";
import { makeJobDue, resetDatabase, retentionV1 } from "./helpers.js";
import { startInMemoryTracing } from "../fixtures/inMemoryTracing.js";

const tracing = startInMemoryTracing();
afterAll(() => tracing.close());
beforeEach(resetDatabase);
const parent = () => ({
    traceParent: `00-${randomBytes(16).toString("hex")}-${randomBytes(8).toString("hex")}-01`,
    traceState: "vendor=example",
});

it("adds nullable context fields while preserving old job data", async () => {
    const migration = await readFile(new URL(
        "../../prisma/migrations/20261016020305_add_job_trace_context/migration.sql", import.meta.url,
    ), "utf8");
    const schema = `trace_migration_${randomUUID().replaceAll("-", "")}`;
    const rollback = new Error("rollback fixture");
    await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        await tx.$executeRawUnsafe(`SET LOCAL search_path = "${schema}"`);
        await tx.$executeRawUnsafe("CREATE TABLE jobs (id text, status text, attempts int)");
        await tx.$executeRawUnsafe("INSERT INTO jobs VALUES ('old-job', 'queued', 2)");
        await tx.$executeRawUnsafe(migration);
        expect(await tx.$queryRawUnsafe("SELECT * FROM jobs")).toEqual([
            { id: "old-job", status: "queued", attempts: 2, trace_parent: null, trace_state: null },
        ]);
        throw rollback;
    })).rejects.toBe(rollback);
});

it("persists active context on creation and preserves nullable legacy/disabled behavior", async () => {
    const saved = parent();
    const job = await context.with(jobParentContext(saved), () => createJob("test", {}));
    expect(job).toMatchObject(saved);
    const plain = await createJob("test", {});
    expect(plain).toMatchObject({ traceParent: null, traceState: null });
    expect(await claimNextJob(randomUUID(), 60000)).toMatchObject({ id: job.id, ...saved });
    expect(await claimNextJob(randomUUID(), 60000)).toMatchObject({
        id: plain.id, traceParent: null, traceState: null,
    });
});

it("persists the run request context on every dataset job", async () => {
    await loadDataset(await readDatasetFile(retentionV1));
    const saved = parent();
    const result = await context.with(jobParentContext(saved), () => createRun({
        datasetName: "retention", datasetVersion: 1, promptVersion: "v1",
    }));
    if (!result.ok) throw new Error("Run creation failed");
    const jobs = await prisma.job.findMany({ where: { runId: result.run.id } });
    expect(jobs).toHaveLength(20);
    expect(jobs.every((job) =>
        job.traceParent === saved.traceParent && job.traceState === saved.traceState,
    )).toBe(true);
});

it("keeps concurrent job creation/claims attached to their own persisted contexts", async () => {
    const jobs = await Promise.all(Array.from({ length: 12 }, () => {
        const saved = parent();
        return context.with(jobParentContext(saved), () => createJob("test", {}));
    }));
    const expected = new Map(jobs.map((job) => [job.id, job.traceParent]));
    const claimed = (await Promise.all(Array.from({ length: 20 }, () => claimNextJob(randomUUID(), 60000))))
        .filter((job) => job !== null);
    expect(claimed).toHaveLength(12);
    expect(new Set(claimed.map((job) => job.id)).size).toBe(12);
    expect(new Set(claimed.map((job) => job.traceParent)).size).toBe(12);
    for (const job of claimed) expect(job.traceParent).toBe(expected.get(job.id));
});

it("retains context through worker retry, reaper recovery, exhaustion and stale writes", async () => {
    const saved = parent();
    const job = await context.with(jobParentContext(saved), () => createJob("test", {}, 3));
    const first = (await claimNextJob(randomUUID(), 60000))!;
    expect(await failOrRetryJob({ ...first, error: "retry" })).toMatchObject({ status: "queued", ...saved });
    await makeJobDue(job.id);
    const second = (await claimNextJob(randomUUID(), 60000))!;
    expect(second).toMatchObject({ attempts: 2, ...saved });
    await prisma.job.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(0) } });
    await reapExpiredJobs();
    expect(await failOrRetryJob({ ...second, error: "stale" })).toBeNull();
    await makeJobDue(job.id);
    const third = (await claimNextJob(randomUUID(), 60000))!;
    expect(third).toMatchObject({ attempts: 3, ...saved });
    expect(await failOrRetryJob({ ...third, error: "exhausted" })).toMatchObject({ status: "dead_letter", ...saved });
});

it("replaces context atomically for the winning concurrent manual retry", async () => {
    const old = parent();
    const job = await context.with(jobParentContext(old), () => createJob("test", {}));
    await prisma.job.update({ where: { id: job.id }, data: { status: "dead_letter", attempts: 3 } });
    const callers = Array.from({ length: 8 }, parent);
    const results = await Promise.all(callers.map((saved) =>
        context.with(jobParentContext(saved), () => retryJob(job.id)),
    ));
    const winners = results.flatMap((result, i) => result.ok ? [i] : []);
    expect(winners).toHaveLength(1);
    expect(await claimNextJob(randomUUID(), 60000)).toMatchObject({
        id: job.id, attempts: 1, ...callers[winners[0]],
    });
});

it("clears old context when manually retried without an active trace", async () => {
    const job = await prisma.job.create({ data: { type: "test", input: {}, status: "dead_letter", ...parent() } });
    expect(await retryJob(job.id)).toMatchObject({ ok: true, job: { traceParent: null, traceState: null } });
});
