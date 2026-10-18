import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { createRun } from "../../src/runs.js";
import { claimNextJob, failOrRetryJob, retryJob } from "../../src/jobs.js";
import { loadDataset, readDatasetFile } from "../../src/datasets.js";
import { makeJobDue, resetDatabase, retentionV1, startRun } from "./helpers.js";
import { JobInputSchema } from "../../src/types.js";

beforeEach(resetDatabase);
afterEach(() => vi.unstubAllEnvs());

it("copies the selected Gemini model into every job and rejects disallowed models before insertion", async () => {
    await loadDataset(await readDatasetFile(retentionV1));
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODELS", "gemini-selected");
    const llm = { provider: "gemini" as const, model: "gemini-selected" };
    const result = await createRun({ datasetName: "retention", datasetVersion: 1, llm });
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect(result.run).toMatchObject(llm);
    const jobs = await prisma.job.findMany({ where: { runId: result.run.id } });
    expect(jobs).toHaveLength(20);
    for (const job of jobs) expect(JobInputSchema.parse(job.input).llm).toEqual(llm);
    expect(await createRun({ datasetName: "retention", datasetVersion: 1,
        llm: { provider: "gemini", model: "gemini-disallowed" } }))
        .toMatchObject({ ok: false, reason: "invalid_llm_selection" });
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(await createRun({ datasetName: "retention", datasetVersion: 1, llm }))
        .toMatchObject({ ok: false, reason: "invalid_llm_selection", message: expect.stringContaining("GEMINI_API_KEY") });
    expect(await prisma.run.count()).toBe(1);
    expect(await prisma.job.count()).toBe(20);
});

it("atomically pins legacy run/standalone jobs and preserves selections across concurrent claims and retries", async () => {
    const { run, jobs } = await startRun();
    const llm = { provider: "gemini", model: "gemini-legacy" };
    await prisma.run.update({ where: { id: run.id }, data: llm });
    await prisma.job.deleteMany({ where: { id: { not: jobs[0].id } } });
    const { llm: _old, ...legacy } = JobInputSchema.parse(jobs[0].input);
    await prisma.job.update({ where: { id: jobs[0].id }, data: { input: legacy, maxAttempts: 2 } });
    const claims = await Promise.all([claimNextJob(randomUUID(), 60_000), claimNextJob(randomUUID(), 60_000)]);
    const claim = claims.find((entry) => entry !== null)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(JobInputSchema.parse(claim.input).llm).toEqual(llm);
    await failOrRetryJob({ ...claim, error: "test retry" });
    await makeJobDue(claim.id);
    vi.stubEnv("LLM_PROVIDER", "gemini");
    const retry = await claimNextJob(randomUUID(), 60_000);
    expect(JobInputSchema.parse(retry!.input).llm).toEqual(llm);
    await failOrRetryJob({ ...retry!, error: "exhausted" });
    await retryJob(retry!.id);
    const manual = await claimNextJob(randomUUID(), 60_000);
    expect(JobInputSchema.parse(manual!.input).llm).toEqual(llm);

    vi.stubEnv("LLM_PROVIDER", "mock");
    await prisma.job.create({ data: { type: "retention_risk_analysis", input: { userId: "legacy" } } });
    const standalone = await claimNextJob(randomUUID(), 60_000);
    expect(JobInputSchema.parse(standalone!.input).llm).toEqual({ provider: "mock", model: "mock-rule-based" });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: standalone!.id } })).input).toEqual(standalone!.input);
});

function processFor(entry: string, env: NodeJS.ProcessEnv) {
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
        env: { ...process.env, PORT: "0", POLL_INTERVAL_MS: "10", ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    child.stdout.on("data", (data) => { logs = (logs + data).slice(-8000); });
    child.stderr.on("data", (data) => { logs = (logs + data).slice(-8000); });
    const closed = once(child, "close");
    const deadline = setTimeout(() => child.kill("SIGKILL"), 12_000);
    void closed.then(() => clearTimeout(deadline));
    return {
        async until(predicate: () => boolean | Promise<boolean>) {
            const deadline = Date.now() + 10_000;
            while (!(await predicate())) {
                if (child.exitCode !== null || Date.now() > deadline) throw new Error(logs);
                await sleep(20);
            }
        },
        logs: () => logs,
        async stop() { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); await closed; },
    };
}

it("fails a saved Gemini job clearly under mock worker defaults with no key or mock result", async () => {
    await prisma.job.create({ data: { type: "retention_risk_analysis", maxAttempts: 1,
        input: { userId: "test", llm: { provider: "gemini", model: "gemini-test" } } } });
    const worker = processFor("src/worker.ts", { LLM_PROVIDER: "mock", GEMINI_API_KEY: "" });
    try {
        await worker.until(async () => await prisma.job.count({ where: { status: "dead_letter" } }) === 1);
        const job = await prisma.job.findFirstOrThrow();
        expect(job.error).toContain("GEMINI_API_KEY");
        expect(job.result).toBeNull();
        expect(await prisma.eval.count()).toBe(0);
        expect(await prisma.trace.count({ where: { stepName: "llm_call" } })).toBe(0);
        expect(await prisma.providerRateLimit.count()).toBe(0);
    } finally { await worker.stop(); }
}, 15_000);

it("exposes a safe catalog and validates HTTP run selection and single-job default pinning", async () => {
    await loadDataset(await readDatasetFile(retentionV1));
    const api = processFor("src/api.ts", { LLM_PROVIDER: "mock", GEMINI_API_KEY: "test-key", GEMINI_MODELS: "gemini-http" });
    try {
        await api.until(() => /http:\/\/127\.0\.0\.1:\d+/.test(api.logs()));
        const url = api.logs().match(/http:\/\/127\.0\.0\.1:\d+/)![0];
        const catalog = await (await fetch(`${url}/llm-options`)).json();
        expect(catalog.providers[1]).toMatchObject({ provider: "gemini", available: true });
        expect(catalog.providers[1].models).toContain("gemini-http");
        expect(JSON.stringify(catalog)).not.toContain("test-key");
        const submit = (llm: object) => fetch(`${url}/runs`, { method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ datasetName: "retention", datasetVersion: 1, llm }),
        });
        const selected = await submit({ provider: "gemini", model: "gemini-http" });
        expect(selected.status).toBe(201);
        expect((await selected.json()).run).toMatchObject({ provider: "gemini", model: "gemini-http" });
        expect((await submit({ provider: "gemini", model: "gemini-not-configured" })).status).toBe(400);
        expect((await submit({ provider: "mock", model: "gemini-http" })).status).toBe(400);
        const single = await fetch(`${url}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "retention_risk_analysis", input: { userId: "test" } }),
        });
        expect(single.status).toBe(201);
        expect((await single.json()).input.llm).toEqual({ provider: "mock", model: "mock-rule-based" });
        expect(await prisma.run.count()).toBe(1);
    } finally { await api.stop(); }
}, 15_000);
