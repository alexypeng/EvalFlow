import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { resetDatabase, retentionV1 } from "./helpers.js";
import { prisma } from "../../src/db.js";
import { loadDataset, readDatasetFile } from "../../src/datasets.js";

beforeEach(resetDatabase);

async function collector() {
    const bodies: Buffer[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        bodies.push(Buffer.concat(chunks));
        response.writeHead(200, { "Content-Type": "application/x-protobuf" }).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing collector port");
    return {
        bodies, endpoint: `http://127.0.0.1:${address.port}/v1/traces`,
        async close() { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); },
    };
}

function child(entry: string, endpoint: string, disabled = "false", env: NodeJS.ProcessEnv = {}) {
    const process = spawn(globalThis.process.execPath, [
        "--experimental-loader=@opentelemetry/instrumentation/hook.mjs", "--import", "tsx", entry,
    ], {
        env: { ...globalThis.process.env, PORT: "0", POLL_INTERVAL_MS: "20", OTEL_SDK_DISABLED: disabled,
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint, ...env },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let logs = "";
    process.stdout.on("data", (data) => { logs += data.toString(); });
    process.stderr.on("data", (data) => { logs += data.toString(); });
    const closed = once(process, "close");
    const deadline = setTimeout(() => process.kill("SIGKILL"), 12000);
    void closed.then(() => clearTimeout(deadline));
    return {
        process, closed, logs: () => logs,
        async until(predicate: () => boolean | Promise<boolean>) {
            const deadline = Date.now() + 10000;
            while (!(await predicate())) {
                if (process.exitCode !== null || Date.now() > deadline) throw new Error(logs);
                await sleep(20);
            }
        },
        async stop() {
            if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
            await closed;
        },
    };
}

it("exports actual HTTP, Fastify and Postgres spans with the supplied trace ID, excluding monitoring", async () => {
    const target = await collector();
    const run = child("src/startApi.ts", target.endpoint);
    try {
        await run.until(() => /http:\/\/127\.0\.0\.1:\d+/.test(run.logs()));
        const url = run.logs().match(/http:\/\/127\.0\.0\.1:\d+/)![0];
        expect((await fetch(url + "/health?check=1")).status).toBe(200);
        expect((await fetch(url + "/metrics?check=1")).status).toBe(200);
        await sleep(1200);
        expect(target.bodies).toHaveLength(0);
        const traceId = "aabbccddeeff00112233445566778899";
        expect((await fetch(url + "/jobs", { headers: {
            traceparent: `00-${traceId}-1122334455667788-01`, authorization: "Bearer not-recorded-test-secret",
        } })).status).toBe(200);
        await run.until(() => Buffer.concat(target.bodies).includes(Buffer.from("pg.query")));
        const payload = Buffer.concat(target.bodies);
        expect(payload.includes(Buffer.from(traceId, "hex"))).toBe(true);
        expect(payload.includes(Buffer.from("evalflow-api"))).toBe(true);
        expect(payload.includes(Buffer.from("/jobs"))).toBe(true);
        expect(payload.includes(Buffer.from("fastify"))).toBe(true);
        expect(payload.includes(Buffer.from("not-recorded-test-secret"))).toBe(false);
        expect(payload.includes(Buffer.from("/metrics"))).toBe(false);
        await sleep(1200);
        const exports = target.bodies.length;
        await fetch(url + "/jobs", { headers: { traceparent: `00-${traceId}-1122334455667788-00` } });
        await sleep(1200);
        expect(target.bodies).toHaveLength(exports);
        run.process.kill("SIGTERM");
        expect(await run.closed).toEqual([0, null]);
    } finally {
        await run.stop();
        await target.close();
    }
}, 20000);

it("saves HTTP trace context on enqueue and replaces it from the manual-retry request", async () => {
    const target = await collector();
    const run = child("src/startApi.ts", target.endpoint);
    try {
        await run.until(() => /http:\/\/127\.0\.0\.1:\d+/.test(run.logs()));
        const url = run.logs().match(/http:\/\/127\.0\.0\.1:\d+/)![0];
        const original = "1".repeat(32), replacement = "2".repeat(32);
        const response = await fetch(url + "/jobs", {
            method: "POST", headers: { "Content-Type": "application/json",
                traceparent: `00-${original}-1122334455667788-01`, tracestate: "vendor=original" },
            body: JSON.stringify({ type: "retention_risk_analysis", input: { userId: "user_123" } }),
        });
        expect(response.status).toBe(201);
        const job = await response.json() as { id: string; traceParent: string; traceState: string };
        expect(job.traceParent).toMatch(new RegExp(`^00-${original}-[a-f0-9]{16}-01$`));
        expect(job.traceState).toBe("vendor=original");
        await prisma.job.update({ where: { id: job.id }, data: { status: "dead_letter", attempts: 3 } });
        const retried = await fetch(url + `/jobs/${job.id}/retry`, { method: "POST", headers: {
            traceparent: `00-${replacement}-1122334455667788-01`, tracestate: "vendor=replacement",
        } });
        expect(retried.status).toBe(200);
        const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
        expect(saved.traceParent).toMatch(new RegExp(`^00-${replacement}-[a-f0-9]{16}-01$`));
        expect(saved.traceState).toBe("vendor=replacement");
        expect(saved.attempts).toBe(0);
        run.process.kill("SIGTERM");
        expect(await run.closed).toEqual([0, null]);
    } finally { await run.stop(); await target.close(); }
}, 20000);

it("exports one span per real worker attempt for retries, concurrent jobs and missing context", async () => {
    const target = await collector();
    const original = "3".repeat(32), other = "4".repeat(32);
    const failing = await prisma.job.create({ data: {
        type: "retention_risk_analysis", input: { userId: "user_123", mockConfig: {} }, maxAttempts: 2,
        traceParent: `00-${original}-1122334455667788-01`, traceState: "vendor=original",
    } });
    const successful = await prisma.job.create({ data: {
        type: "retention_risk_analysis", input: { userId: "user_healthy" },
        traceParent: `00-${other}-1122334455667788-01`,
    } });
    const legacy = await prisma.job.create({ data: { type: "retention_risk_analysis", input: { userId: "legacy" } } });
    const run = child("src/startWorker.ts", target.endpoint, "false", { WORKER_CONCURRENCY: "2" });
    try {
        await run.until(async () => (await prisma.job.findMany()).every((job) =>
            ["completed", "dead_letter"].includes(job.status),
        ));
        expect(await prisma.job.findUniqueOrThrow({ where: { id: failing.id } })).toMatchObject({
            status: "dead_letter", attempts: 2, traceParent: failing.traceParent, traceState: failing.traceState,
        });
        expect(await prisma.job.findUniqueOrThrow({ where: { id: successful.id } })).toMatchObject({
            status: "completed", traceParent: successful.traceParent, traceState: null,
        });
        expect(await prisma.job.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({
            status: "completed", traceParent: null, traceState: null,
        });
        run.process.kill("SIGTERM");
        expect(await run.closed).toEqual([0, null]);
        const payload = Buffer.concat(target.bodies);
        expect(payload.includes(Buffer.from(original, "hex"))).toBe(true);
        expect(payload.includes(Buffer.from(other, "hex"))).toBe(true);
        for (const id of [failing.id, successful.id, legacy.id]) expect(payload.includes(Buffer.from(id))).toBe(true);
        expect(payload.toString("latin1").match(/job\.process/g)).toHaveLength(4);
        expect(payload.includes(Buffer.from("evalflow-worker"))).toBe(true);
    } finally { await run.stop(); await target.close(); }
}, 20000);

it.each([
    { label: "successful pipeline", mockConfig: { latencyMs: 30 },
        status: "completed", parse: 1, validate: 1, eval: 1 },
    { label: "invalid JSON", mockConfig: { invalidJsonRate: 1 },
        status: "dead_letter", parse: 1, validate: 0, eval: 0 },
    { label: "invalid schema", mockConfig: { missingEvidenceRate: 1 },
        status: "dead_letter", parse: 1, validate: 1, eval: 0 },
    { label: "wrong label", mockConfig: { wrongLabelRate: 1 }, status: "completed", parse: 1, validate: 1, eval: 1 },
    { label: "rejected call", mockConfig: {}, status: "dead_letter", parse: 0, validate: 0, eval: 0 },
    { label: "enabled permit", mockConfig: {}, status: "completed", parse: 1, validate: 1, eval: 1 },
])("exports operation spans for $label without capturing prompt/output payloads", async (scenario) => {
    await loadDataset(await readDatasetFile(retentionV1));
    const datasetCase = await prisma.datasetCase.findFirstOrThrow({ where: { name: "clear_high_all_signals" } });
    const job = await prisma.job.create({ data: {
        type: "retention_risk_analysis", maxAttempts: 1,
        caseId: scenario.label === "rejected call" ? null : datasetCase.id,
        input: { userId: "pipeline-private-payload-sentinel", snapshot: datasetCase.snapshot,
            expectedRisk: datasetCase.expectedRisk, mockConfig: scenario.mockConfig },
    } });
    const target = await collector();
    const run = child("src/startWorker.ts", target.endpoint, "false", {
        RATE_LIMIT_MOCK: scenario.label === "enabled permit" ? "true" : "false",
    });
    try {
        await run.until(async () =>
            (await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status === scenario.status,
        );
        run.process.kill("SIGTERM");
        expect(await run.closed).toEqual([0, null]);
        const payload = Buffer.concat(target.bodies).toString("latin1");
        const count = (name: string) => payload.split(name).length - 1;
        for (const name of ["tool.get_user_events", "tool.get_feature_usage", "tool.get_subscription_history",
            "tool.get_retention_summary", "prompt.build", "llm.call"]) expect(count(name)).toBe(1);
        expect(count("output.parse")).toBe(scenario.parse);
        expect(count("output.validate")).toBe(scenario.validate);
        expect(count("evaluation.score")).toBe(scenario.eval);
        expect(count("provider.permit_wait")).toBe(scenario.label === "enabled permit" ? 1 : 0);
        expect(payload).toContain("gen_ai.request.model");
        expect(payload).toContain("mock-rule-based");
        expect(payload.includes("gen_ai.usage.input_tokens")).toBe(scenario.label !== "rejected call");
        expect(payload).not.toContain("pipeline-private-payload-sentinel");
        if (scenario.label === "wrong label") {
            expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).evalScore).toBeLessThan(100);
        }
    } finally { await run.stop(); await target.close(); }
}, 15000);

it.each(["lease_lost", "cancelled"] as const)(
    "records an interrupted permit span as %s without starting the LLM", async (outcome) => {
        const job = await prisma.job.create({ data: {
            type: "retention_risk_analysis", input: { userId: "user_123" },
        } });
        await prisma.$executeRaw`
            INSERT INTO provider_rate_limits (provider, tokens, refilled_at)
            VALUES ('mock', 0, clock_timestamp() + interval '1 hour')
        `;
        const bucketVersion = async () => {
            const [row] = await prisma.$queryRaw<Array<{ version: string }>>`
                SELECT xmin::text AS version FROM provider_rate_limits WHERE provider = 'mock'
            `;
            return row.version;
        };
        const originalVersion = await bucketVersion();
        const target = await collector();
        const run = child("src/startWorker.ts", target.endpoint, "false", {
            RATE_LIMIT_MOCK: "true", LEASE_DURATION_MS: "600", HEARTBEAT_INTERVAL_MS: "50",
        });
        try {
            await run.until(async () => await prisma.trace.count({ where: { jobId: job.id } }) === 4);
            await run.until(async () => await bucketVersion() !== originalVersion);
            if (outcome === "lease_lost") {
                await prisma.job.update({ where: { id: job.id }, data: {
                    lockedBy: randomUUID(), leaseToken: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60000),
                } });
                await run.until(() => run.logs().includes("Job lease lost"));
            }
            run.process.kill("SIGTERM");
            expect(await run.closed).toEqual([0, null]);
            const payload = Buffer.concat(target.bodies).toString("latin1");
            expect(payload.split("provider.permit_wait")).toHaveLength(2);
            expect(payload).toContain(outcome);
            expect(payload).not.toContain("llm.call");
            expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status)
                .toBe(outcome === "lease_lost" ? "running" : "queued");
        } finally { await run.stop(); await target.close(); }
    }, 15000,
);

it("flushes a pending span on shutdown exactly once", async () => {
    const target = await collector();
    const run = child("test/fixtures/telemetryShutdown.ts", target.endpoint);
    try {
        expect(await run.closed).toEqual([0, null]);
        expect(target.bodies).toHaveLength(1);
        expect(target.bodies[0].includes(Buffer.from("shutdown-flush-test"))).toBe(true);
    } finally { await run.stop(); await target.close(); }
}, 15000);

it("keeps idle worker polling out of traces and exits cleanly with tracing enabled", async () => {
    const target = await collector();
    const run = child("src/startWorker.ts", target.endpoint);
    try {
        await run.until(() => run.logs().includes("polling every"));
        await sleep(1200);
        expect(target.bodies).toHaveLength(0);
        run.process.kill("SIGTERM");
        expect(await run.closed).toEqual([0, null]);
        expect(run.logs()).toContain("Tracing enabled for evalflow-worker");
        expect(run.logs()).toContain("Worker shutdown complete");
    } finally { await run.stop(); await target.close(); }
}, 15000);

it("bounds shutdown when the trace receiver accepts a connection but never responds", async () => {
    const server = createServer(() => {});
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing receiver port");
    const started = performance.now();
    const run = child("test/fixtures/telemetryShutdown.ts", `http://127.0.0.1:${address.port}/v1/traces`);
    try {
        expect(await run.closed).toEqual([0, null]);
        expect(performance.now() - started).toBeLessThan(8000);
        expect(run.logs()).toContain("Telemetry shutdown complete");
        expect(run.logs()).toContain("Trace export shutdown failed");
    } finally {
        await run.stop();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}, 15000);

it("exits after a failed trace export without treating telemetry loss as application failure", async () => {
    const target = await collector();
    const endpoint = target.endpoint;
    await target.close();
    const run = child("test/fixtures/telemetryShutdown.ts", endpoint);
    try {
        expect(await run.closed).toEqual([0, null]);
        expect(run.logs()).toContain("Telemetry shutdown complete");
        expect(run.logs()).toContain("Trace export shutdown failed");
    } finally { await run.stop(); }
}, 15000);
