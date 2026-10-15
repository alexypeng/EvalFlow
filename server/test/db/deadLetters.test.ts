import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { claimNextJob, getMetrics, listJobs, retryJob } from "../../src/jobs.js";
import { resetDatabase } from "./helpers.js";

beforeEach(resetDatabase);

it("preserves existing failed rows and trace references when renaming the enum", async () => {
    const migration = await readFile(new URL(
        "../../prisma/migrations/20261014010000_rename_failed_to_dead_letter/migration.sql", import.meta.url,
    ), "utf8");
    const schema = `migration_test_${randomUUID().replaceAll("-", "")}`;
    const rollback = new Error("rollback isolated migration fixture");
    await expect(prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
        // No public search path: the migration can only touch this isolated fixture enum.
        await tx.$executeRawUnsafe(`SET LOCAL search_path = "${schema}"`);
        await tx.$executeRawUnsafe(`CREATE TYPE "JobStatus" AS ENUM ('queued', 'running', 'completed', 'failed')`);
        await tx.$executeRawUnsafe(`CREATE TABLE jobs (
            id text PRIMARY KEY, status "JobStatus", error text, attempts int
        )`);
        await tx.$executeRawUnsafe(`CREATE TABLE traces (job_id text REFERENCES jobs(id), output text)`);
        await tx.$executeRawUnsafe(`INSERT INTO jobs VALUES ('old-job', 'failed', 'provider unavailable', 3)`);
        await tx.$executeRawUnsafe(`INSERT INTO traces VALUES ('old-job', 'original trace')`);
        await tx.$executeRawUnsafe(migration);
        expect(await tx.$queryRawUnsafe(`SELECT id, status::text, error, attempts FROM jobs`)).toEqual([
            { id: "old-job", status: "dead_letter", error: "provider unavailable", attempts: 3 },
        ]);
        expect(await tx.$queryRawUnsafe(`SELECT * FROM traces`)).toEqual([
            { job_id: "old-job", output: "original trace" },
        ]);
        throw rollback;
    })).rejects.toBe(rollback);
});

it("filters dead letters before limiting the list and includes them in failed metrics", async () => {
    const old = await prisma.job.create({ data: {
        type: "test", input: {}, status: "dead_letter", attempts: 3,
        createdAt: new Date("2020-01-01T00:00:00Z"), error: "inspect me",
    } });
    await prisma.job.createMany({ data: Array.from({ length: 101 }, () => ({ type: "test", input: {} })) });
    expect(await listJobs()).toHaveLength(100);
    expect((await listJobs()).some((job) => job.id === old.id)).toBe(false);
    expect((await listJobs("dead_letter")).map((job) => job.id)).toEqual([old.id]);
    expect(await getMetrics()).toMatchObject({ totalJobs: 102, failedJobs: 1 });
});

it("accepts one concurrent requeue, keeps history and immediately issues a fresh claim", async () => {
    const job = await prisma.job.create({ data: {
        type: "test", input: { userId: "original" }, status: "dead_letter", attempts: 3,
        error: "old failure", completedAt: new Date(),
    } });
    await prisma.trace.create({ data: { jobId: job.id, stepName: "llm_call", output: { error: "old failure" } } });
    const results = await Promise.all(Array.from({ length: 10 }, () => retryJob(job.id)));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok).every((result) => result.reason === "not_dead_letter")).toBe(true);
    expect(await prisma.trace.count({ where: { jobId: job.id } })).toBe(1);
    const queued = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(queued).toMatchObject({
        status: "queued", attempts: 0, error: null, completedAt: null,
        lockedBy: null, leaseToken: null, leaseExpiresAt: null, input: { userId: "original" },
    });
    expect(await claimNextJob(randomUUID(), 60_000)).toMatchObject({ id: job.id, attempts: 1 });
});

it("serves validated filters and restricts the retry endpoint to dead-lettered jobs", async () => {
    const dead = await prisma.job.create({ data: { type: "test", input: {}, status: "dead_letter", attempts: 3 } });
    const queued = await prisma.job.create({ data: { type: "test", input: {} } });
    const api = spawn(process.execPath, ["--import", "tsx", "src/api.ts"], {
        cwd: process.cwd(), env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(api, "exit");
    let logs = "";
    api.stdout.on("data", (data) => { logs = (logs + data.toString()).slice(-5000); });
    api.stderr.on("data", (data) => { logs = (logs + data.toString()).slice(-5000); });
    try {
        const deadline = Date.now() + 8000;
        while (!logs.match(/http:\/\/127\.0\.0\.1:\d+/)) {
            if (api.exitCode !== null || Date.now() > deadline) throw new Error(logs || "API did not start");
            await sleep(10);
        }
        const base = logs.match(/http:\/\/127\.0\.0\.1:\d+/)![0];
        const filtered = await fetch(`${base}/jobs?status=dead_letter`);
        expect(filtered.status).toBe(200);
        expect((await filtered.json()).map((job: { id: string }) => job.id)).toEqual([dead.id]);
        for (const query of ["status=failed", "status=unknown", "status=", "status=queued&status=running"]) {
            expect((await fetch(`${base}/jobs?${query}`)).status).toBe(400);
        }
        expect((await fetch(`${base}/jobs/${queued.id}/retry`, { method: "POST" })).status).toBe(409);
        expect((await fetch(`${base}/jobs/${randomUUID()}/retry`, { method: "POST" })).status).toBe(404);
        expect((await fetch(`${base}/jobs/invalid/retry`, { method: "POST" })).status).toBe(404);
        const retried = await fetch(`${base}/jobs/${dead.id}/retry`, { method: "POST" });
        expect(retried.status).toBe(200);
        expect(await retried.json()).toMatchObject({ id: dead.id, status: "queued", attempts: 0 });
        expect(await (await fetch(`${base}/jobs?status=dead_letter`)).json()).toEqual([]);
    } finally {
        api.kill("SIGTERM");
        const timeout = setTimeout(() => api.kill("SIGKILL"), 3000);
        await exited;
        clearTimeout(timeout);
    }
}, 15_000);
