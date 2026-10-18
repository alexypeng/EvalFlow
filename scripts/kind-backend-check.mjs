import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const args = ["--kubeconfig", `${repo}.evalflow-kind/kubeconfig`, "--context", "kind-evalflow", "-n", "evalflow"];
const components = ["api", "worker", "reaper"];
const ports = { api: 3000, worker: 9100, reaper: 9101 };
const jobs = [];
let restoringDatabase = false;
let logWatch;

function kube(...command) {
    return execFileSync("kubectl", [...args, ...command], { encoding: "utf8", timeout: 210_000 }).trim();
}
function pods() {
    return JSON.parse(kube("get", "pods", "-l", "app.kubernetes.io/instance=evalflow-app", "-o", "json"))
        .items.filter((pod) => !pod.metadata.deletionTimestamp &&
            components.includes(pod.metadata.labels["app.kubernetes.io/component"]));
}
function podFor(component) {
    const matches = pods().filter((pod) => pod.metadata.labels["app.kubernetes.io/component"] === component);
    assert.equal(matches.length, 1, `Expected one ${component} Pod; run this check before autoscaling is enabled`);
    return matches[0];
}
function runNode(pod, source) {
    return execFileSync("kubectl", [...args, "exec", "-i", pod, "--", "node", "--input-type=module"], {
        input: `try { ${source} } catch (error) { console.error(error.message); process.exitCode = 1; }`,
        encoding: "utf8", timeout: 20_000,
    }).trim();
}
async function until(label, check, timeout = 60_000) {
    const deadline = Date.now() + timeout;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await sleep(300);
    }
}
function api(path, method = "GET", body) {
    const client = podFor("api").metadata.name;
    return JSON.parse(runNode(client, `
        const response = await fetch(${JSON.stringify(`http://evalflow-app-api:3000${path}`)}, {
            method: ${JSON.stringify(method)}, headers: {"content-type":"application/json"},
            body: ${JSON.stringify(body === undefined ? undefined : JSON.stringify(body))},
            signal: AbortSignal.timeout(5000),
        });
        const text = await response.text();
        if (!response.ok) throw new Error("API status " + response.status + ": " + text);
        console.log(text);
    `));
}
function fixture(source) {
    return runNode(podFor("api").metadata.name, `
        const url = new URL("postgresql://localhost");
        url.hostname = process.env.PGHOST; url.port = process.env.PGPORT;
        url.username = encodeURIComponent(process.env.PGUSER);
        url.password = encodeURIComponent(process.env.PGPASSWORD);
        url.pathname = "/" + encodeURIComponent(process.env.PGDATABASE);
        process.env.DATABASE_URL = url.toString();
        const { prisma } = await import("./dist/db.js");
        try { ${source} } finally { await prisma.$disconnect(); }
    `);
}
function endpoint(pod, port, path) {
    return Number(runNode(pod, `
        const response = await fetch("http://127.0.0.1:${port}${path}", {signal: AbortSignal.timeout(4000)});
        console.log(response.status);
    `));
}
function restoreDatabase() {
    kube("scale", "statefulset", "evalflow-postgres", "--replicas=1");
    kube("wait", "--for=create", "pod/evalflow-postgres-0", "--timeout=180s");
    kube("wait", "--for=condition=Ready", "pod/evalflow-postgres-0", "--timeout=180s");
    restoringDatabase = false;
}
function allReady(expected) {
    const current = pods();
    return current.length === 3 && current.every((pod) =>
        pod.status.conditions.some((condition) => condition.type === "Ready" && condition.status === String(expected)));
}

try {
    await until("backend ready", () => allReady("True"));
    const active = fixture('console.log(await prisma.job.count({where:{status:{in:["queued","running"]}}}));');
    assert.equal(active, "0", "Run this check on an idle local queue");
    const job = api("/jobs", "POST", { type: "retention_risk_analysis", input: { userId: "user_123" } });
    jobs.push(job.id);
    await until("API job completed", () => api(`/jobs/${job.id}`).job.status === "completed");
    assert.equal(api(`/jobs/${job.id}`).job.attempts, 1);
    console.log("PASS: API Service → Postgres queue → worker → completed job.");

    const original = pods();
    restoringDatabase = true;
    kube("scale", "statefulset", "evalflow-postgres", "--replicas=0");
    kube("wait", "--for=delete", "pod/evalflow-postgres-0", "--timeout=90s");
    await until("backend unready during DB outage", () => allReady("False"));
    for (const pod of original) {
        const component = pod.metadata.labels["app.kubernetes.io/component"];
        assert.equal(endpoint(pod.metadata.name, ports[component], "/livez"), 200);
        assert.equal(endpoint(pod.metadata.name, ports[component], "/readyz"), 503);
    }
    const slices = JSON.parse(kube("get", "endpointslices", "-l",
        "kubernetes.io/service-name=evalflow-app-api", "-o", "json"));
    assert(slices.items.flatMap((slice) => slice.endpoints ?? []).every((entry) => entry.conditions.ready !== true));
    console.log("DB outage: readiness failed, liveness passed, API Service has no ready endpoints; observing 32 seconds.");
    await sleep(32_000);
    for (const pod of original) {
        const current = JSON.parse(kube("get", "pod", pod.metadata.name, "-o", "json"));
        assert.equal(current.metadata.uid, pod.metadata.uid);
        assert.equal(current.status.containerStatuses[0].restartCount, pod.status.containerStatuses[0].restartCount);
    }
    restoreDatabase();
    await until("backend ready after DB recovery", () => allReady("True"));
    const recovered = api("/jobs", "POST", { type: "retention_risk_analysis", input: { userId: "user_123" } });
    jobs.push(recovered.id);
    await until("job completes after database recovery", () => api(`/jobs/${recovered.id}`).job.status === "completed");
    console.log("PASS: database outage removed readiness without backend restarts; job processing recovered.");

    const abandoned = fixture(`
        const job = await prisma.job.create({data:{type:"retention_risk_analysis",input:{userId:"user_123"},
            status:"running",attempts:1,maxAttempts:1,lockedBy:crypto.randomUUID(),
            leaseToken:crypto.randomUUID(),leaseExpiresAt:new Date(Date.now()-10000)}});
        console.log(job.id);
    `);
    jobs.push(abandoned);
    await until("reaper dead-letters abandoned final attempt", () => api(`/jobs/${abandoned}`).job.status === "dead_letter");
    console.log("PASS: separate reaper recovers an expired final attempt.");

    const draining = fixture(`
        const {loadDataset,readDatasetFile}=await import("./dist/datasets.js");
        await loadDataset(await readDatasetFile("datasets/retention-v1.json"));
        const item=await prisma.datasetCase.findFirstOrThrow();
        const job=await prisma.job.create({data:{type:"retention_risk_analysis",caseId:item.id,
            input:{userId:"user_123",mockConfig:{latencyMs:12000}},maxAttempts:3}});
        console.log(job.id);
    `);
    jobs.push(draining);
    await until("worker begins slow job", () => {
        const current = api(`/jobs/${draining}`);
        return current.job.status === "running" && current.traces.length >= 4;
    });
    const oldWorker = podFor("worker");
    let logs = "";
    let logAttached = false;
    logWatch = spawn("kubectl", [...args, "logs", "--follow", "--tail=50", oldWorker.metadata.name], {
        stdio: ["ignore", "pipe", "pipe"],
    });
    logWatch.stdout.on("data", (chunk) => {
        logAttached = true;
        logs = (logs + chunk.toString()).slice(-50_000);
    });
    logWatch.stderr.on("data", () => {});
    logWatch.on("error", () => {});
    await until("worker log stream attached", () => logAttached, 5000);
    kube("delete", "pod", oldWorker.metadata.name, "--wait=false");
    await until("graceful worker drain", () => logs.includes("Worker shutdown complete"));
    await until("slow job finishes once", () => api(`/jobs/${draining}`).job.status === "completed");
    const completed = api(`/jobs/${draining}`);
    assert.equal(completed.job.attempts, 1);
    assert(completed.eval);
    assert.equal(fixture(`console.log(await prisma.eval.count({where:{jobId:${JSON.stringify(draining)}}}));`), "1");
    await until("replacement worker ready", () => {
        const replacement = podFor("worker");
        return replacement.metadata.uid !== oldWorker.metadata.uid &&
            replacement.status.conditions.some((condition) => condition.type === "Ready" && condition.status === "True");
    });
    console.log("PASS: Kubernetes SIGTERM drains a running mock call, completes once, and replaces the worker.");
} finally {
    if (restoringDatabase) restoreDatabase();
    logWatch?.kill("SIGTERM");
    if (jobs.length) {
        fixture(`await prisma.job.deleteMany({where:{id:{in:${JSON.stringify(jobs)}}}});`);
    }
}
