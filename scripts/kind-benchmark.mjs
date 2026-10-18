import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, open, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { summarize, markdown } from "../benchmarks/report.mjs";
import { scenario } from "../benchmarks/scenarios.mjs";
import { aggregateSweep, sweepMarkdown } from "../benchmarks/sweepReport.mjs";
import { summarizePolling, aggregatePolling, pollingMarkdown } from "../benchmarks/pollingReport.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const args = ["--kubeconfig", `${repo}.evalflow-kind/kubeconfig`, "--context", "kind-evalflow", "-n", "evalflow"];
const exec = promisify(execFile);
const plan = scenario(process.argv.slice(2));
const source = await readFile(`${repo}benchmarks/produce.mjs`, "utf8");
const stamp = new Date().toISOString().replaceAll(":", "-");
const folder = `${repo}.evalflow-kind/benchmarks/${stamp}`;
const lock = `${repo}.evalflow-kind/benchmark.lock`;
await mkdir(folder, { recursive: true });
const handle = await open(lock, "wx");
await handle.writeFile(JSON.stringify({ pid: process.pid, folder }));
await handle.close();
const pausedKey = "autoscaling.keda.sh/paused-replicas";
const isPolling = plan.methodology === "queue-worker-idle-polling-v1";
const isSweep = plan.methodology === "queue-worker-arrival-sweep-v1";
const report = { capturedAt: new Date().toISOString(), methodology: plan.methodology, plan, trials: [], summaries: [] };
let original, scaler, changed = false, pollingChanged = false, stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    stopping = true;
    console.error("Stop requested: finishing the bounded current trial, then restoring scaling. Do not send another signal.");
});
async function kube(...command) {
    return (await exec("kubectl", [...args, ...command], { timeout: 30_000, maxBuffer: 10_000_000 })).stdout.trim();
}
const deployment = async () => JSON.parse(await kube("get", "deployment", "evalflow-app-worker", "-o", "json"));
async function workerState() {
    const d = await deployment();
    const list = JSON.parse(await kube("get", "pods", "-l", "app.kubernetes.io/component=worker", "-o", "json")).items;
    return { desired: d.spec.replicas, ready: d.status.readyReplicas ?? 0, pods: list.map((pod) => ({
        uid: pod.metadata.uid, name: pod.metadata.name, ip: pod.status.podIP, deleting: Boolean(pod.metadata.deletionTimestamp),
        ready: pod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True") ?? false,
        restarts: pod.status.containerStatuses?.reduce((sum, container) => sum + container.restartCount, 0) ?? 0,
    })).sort((a, b) => a.uid.localeCompare(b.uid)) };
}
async function until(label, check, timeout = 120_000) {
    const deadline = Date.now() + timeout;
    while (!await check()) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await sleep(1000);
    }
}
async function persist() {
    if (isSweep) report.aggregates = aggregateSweep(report);
    if (isPolling) report.aggregates = aggregatePolling(report);
    await writeFile(`${folder}/report.json`, JSON.stringify(report, null, 2));
    await writeFile(`${folder}/report.md`, (isPolling ? pollingMarkdown(report) : isSweep ? sweepMarkdown(report) : markdown(report)));
}
function remote(config) {
    return new Promise((resolve, reject) => {
        const child = spawn("kubectl", [...args, "exec", "-i", "deployment/evalflow-app-api", "--",
            "node", "--input-type=module", "-", JSON.stringify(config)], { stdio: ["pipe", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (chunk) => { output += chunk; });
        child.stderr.on("data", (chunk) => process.stderr.write(chunk));
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code !== 0) return reject(new Error(`Producer exited ${code}; inspect ${folder}/manifest.json for fixture IDs`));
            try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
        });
        child.stdin.on("error", () => {});
        child.stdin.end(source);
    });
}
async function database(source) {
    const cleanupSource = `
        const url = new URL("postgresql://localhost");
        url.hostname=process.env.PGHOST; url.port=process.env.PGPORT;
        url.username=encodeURIComponent(process.env.PGUSER); url.password=encodeURIComponent(process.env.PGPASSWORD);
        url.pathname="/"+encodeURIComponent(process.env.PGDATABASE); process.env.DATABASE_URL=url.toString();
        const {prisma}=await import("./dist/db.js");
        try { ${source} }
        finally { await prisma.$disconnect(); }
    `;
    return (await exec("kubectl", [...args, "exec", "deployment/evalflow-app-api", "--", "node", "--input-type=module", "-e", cleanupSource], { timeout: 20_000 })).stdout.trim();
}
try {
    original = await deployment();
    const env = Object.fromEntries(original.spec.template.spec.containers[0].env.map((item) => [item.name, item.value]));
    assert.equal(env.LLM_PROVIDER, "mock", "Only mock workers are allowed");
    assert.equal(env.WORKER_WAKEUP_MODE ?? "poll", "poll", "Polling benchmarks require polling-only workers");
    assert.equal(env.WORKER_CONCURRENCY, "1", "This scenario requires concurrency 1");
    assert.equal(env.RATE_LIMIT_MOCK, "false", "Mock permits must not throttle this scenario");
    assert(!env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, "Use disabled trace export for this controlled baseline");
    const rawScaler = await kube("get", "scaledobject", "evalflow-app-worker", "--ignore-not-found", "-o", "json");
    scaler = rawScaler ? JSON.parse(rawScaler) : null;
    if (!scaler) {
        const hpas = JSON.parse(await kube("get", "hpa", "-o", "json")).items;
        assert(!hpas.some((hpa) => hpa.spec.scaleTargetRef.name === "evalflow-app-worker"), "Unmanaged HPA would change replicas");
    }
    assert.equal(await database('console.log(await prisma.job.count({where:{status:{in:["queued","running"]}}}));'), "0",
        "Benchmark requires an idle queue before changing worker counts");
    report.environment = {
        gitCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
        producerSha256: createHash("sha256").update(source).digest("hex"),
        reportSha256: createHash("sha256").update(await readFile(`${repo}benchmarks/report.mjs`)).digest("hex"),
        scenarioSha256: createHash("sha256").update(await readFile(`${repo}benchmarks/scenarios.mjs`)).digest("hex"),
        pollingReportSha256: createHash("sha256").update(await readFile(`${repo}benchmarks/pollingReport.mjs`)).digest("hex"),
        sweepReportSha256: createHash("sha256").update(await readFile(`${repo}benchmarks/sweepReport.mjs`)).digest("hex"),
        image: original.spec.template.spec.containers[0].image,
        resources: original.spec.template.spec.containers[0].resources,
        pollIntervalMs: env.POLL_INTERVAL_MS, concurrency: 1, mockPermits: false, tracingExport: false,
        node: JSON.parse(await kube("get", "node", "evalflow-control-plane", "-o", "json")).status.capacity,
        isolation: "Local kind queue; shared Docker host, other services not stopped",
    };
    const configs = plan.trials.map((trial) => ({ ...trial,
        ids: Array.from({ length: trial.jobs }, () => randomUUID()),
        warmupIds: Array.from({ length: trial.workers }, () => randomUUID()),
    }));
    await writeFile(`${folder}/manifest.json`, JSON.stringify({ configs, originalReplicas: original.spec.replicas,
        originalPausedReplicas: scaler?.metadata.annotations?.[pausedKey] ?? null,
        originalPollEnv: original.spec.template.spec.containers[0].env.find((item) => item.name === "POLL_INTERVAL_MS") ?? null }, null, 2));
    for (const config of configs) {
        if (stopping) throw new Error("Benchmark stopped before next trial");
        changed = true;
        if (scaler) {
            await kube("annotate", "scaledobject", "evalflow-app-worker", `${pausedKey}=${config.workers}`, "--overwrite");
            await until("KEDA paused and HPA removed", async () => {
                const current = JSON.parse(await kube("get", "scaledobject", "evalflow-app-worker", "-o", "json"));
                return current.status?.conditions?.some((c) => c.type === "Paused" && c.status === "True") &&
                    !(await kube("get", "hpa", "keda-hpa-evalflow-app-worker", "--ignore-not-found", "-o", "name"));
            });
        } else await kube("scale", "deployment", "evalflow-app-worker", `--replicas=${config.workers}`);
        if (isPolling) {
            pollingChanged = true;
            await kube("patch", "deployment", "evalflow-app-worker", "--type=strategic", "-p", JSON.stringify({
                spec: { template: { spec: { containers: [{ name: "worker", env: [
                    { name: "POLL_INTERVAL_MS", value: String(config.pollIntervalMs) },
                ] }] } } },
            }));
            await kube("rollout", "status", "deployment/evalflow-app-worker", "--timeout=120s");
        }
        await until(`${config.workers} stable ready workers`, async () => {
            const state = await workerState();
            return state.desired === config.workers && state.ready === config.workers &&
                state.pods.length === config.workers && state.pods.every((pod) => pod.ready && !pod.deleting);
        });
        const before = await workerState();
        if (isPolling) {
            const port = env.WORKER_METRICS_PORT ?? "9100";
            config.metricsUrl = `http://${before.pods[0].ip}:${port}/metrics`;
            const current = await deployment();
            assert.equal(current.spec.template.spec.containers[0].env
                .find((item) => item.name === "POLL_INTERVAL_MS").value, String(config.pollIntervalMs));
        }
        console.log(`Starting trial: ${config.workers} workers, ${config.jobs} jobs, ${config.arrivalRate} job/s, repetition ${config.repetition ?? 1}, ${config.latencyMs}ms mock latency${isPolling ? `, poll ${config.pollIntervalMs}ms` : ""}.`);
        const observed = [];
        let finished = false;
        const monitor = (async () => {
            while (!finished) {
                observed.push(await workerState());
                await sleep(3000);
            }
        })().catch((error) => { observed.push({ error: error.message }); });
        let trial;
        try { trial = await remote(config); } finally { finished = true; await monitor; }
        const after = await workerState();
        if (JSON.stringify(before) !== JSON.stringify(after) || observed.some((state) => JSON.stringify(state) !== JSON.stringify(before))) {
            trial.issues.push("Worker replica count, Pod identity, readiness or restart count changed during the trial");
        }
        trial.workerStates = { before, after, observed };
        report.trials.push(trial);
        const summary = isPolling ? summarizePolling(trial) : summarize(trial);
        report.summaries.push(summary);
        await persist();
        console.log(JSON.stringify(summary, null, 2));
        assert(summary.valid, `Invalid trial; inspect ${folder}/report.json`);
        await database(`await prisma.job.deleteMany({where:{id:{in:${JSON.stringify([...config.ids, ...config.warmupIds])}},status:{in:["completed","dead_letter"]}}});`);
    }
    console.log(`Saved JSON and Markdown: ${folder}`);
} finally {
    const restorationErrors = [];
    try {
        try {
            if (pollingChanged && original) {
                const old = original.spec.template.spec.containers[0].env.find((item) => item.name === "POLL_INTERVAL_MS");
                await kube("patch", "deployment", "evalflow-app-worker", "--type=strategic", "-p", JSON.stringify({
                    spec: { template: { spec: { containers: [{ name: "worker", env: [old ??
                        { name: "POLL_INTERVAL_MS", $patch: "delete" }] }] } } },
                }));
                await kube("rollout", "status", "deployment/evalflow-app-worker", "--timeout=120s");
                assert.deepEqual((await deployment()).spec.template.spec.containers[0].env
                    .find((item) => item.name === "POLL_INTERVAL_MS"), old);
                report.pollingSettingRestored = true;
            }
        } catch (error) { restorationErrors.push(error); }
        try {
            if (changed && scaler) {
                await kube("patch", "scaledobject", "evalflow-app-worker", "--type=merge", "-p", JSON.stringify({
                    metadata: { annotations: { [pausedKey]: scaler.metadata.annotations?.[pausedKey] ?? null } },
                }));
                if (!scaler.metadata.annotations?.[pausedKey] && scaler.metadata.annotations?.["autoscaling.keda.sh/paused"] === "true") {
                    await kube("scale", "deployment", "evalflow-app-worker", `--replicas=${original.spec.replicas}`);
                } else if (!scaler.metadata.annotations?.[pausedKey]) {
                    await until("KEDA resumed", async () => {
                        const current = JSON.parse(await kube("get", "scaledobject", "evalflow-app-worker", "-o", "json"));
                        return current.status?.conditions?.some((c) => c.type === "Paused" && c.status === "False");
                    });
                }
            } else if (changed && original) await kube("scale", "deployment", "evalflow-app-worker", `--replicas=${original.spec.replicas}`);
        } catch (error) { restorationErrors.push(error); }
        report.scalingSettingRestored = restorationErrors.length === 0;
        if (report.environment) await persist();
        if (restorationErrors.length) throw new AggregateError(restorationErrors, "Benchmark restoration failed");
    } finally { await unlink(lock); }
}
