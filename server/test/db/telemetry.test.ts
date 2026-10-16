import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { beforeEach, expect, it } from "vitest";
import { resetDatabase } from "./helpers.js";

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

function child(entry: string, endpoint: string, disabled = "false") {
    const process = spawn(globalThis.process.execPath, [
        "--experimental-loader=@opentelemetry/instrumentation/hook.mjs", "--import", "tsx", entry,
    ], {
        env: { ...globalThis.process.env, PORT: "0", POLL_INTERVAL_MS: "20", OTEL_SDK_DISABLED: disabled,
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint },
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
        async until(predicate: () => boolean) {
            const deadline = Date.now() + 10000;
            while (!predicate()) {
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
