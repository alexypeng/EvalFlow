import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const args = ["--kubeconfig", `${repo}.evalflow-kind/kubeconfig`, "--context", "kind-evalflow", "-n", "evalflow"];
const query = readFileSync(`${repo}deploy/helm/evalflow-app/files/worker-demand.sql`, "utf8");
const owned = [];
const stateFile = `${repo}.evalflow-kind/keda-check-jobs.json`;
function remember(...ids) {
    owned.push(...ids);
    writeFileSync(stateFile, JSON.stringify(owned));
}
function kube(...command) {
    return execFileSync("kubectl", [...args, ...command], { encoding: "utf8", timeout: 30_000 }).trim();
}
function fixture(source) {
    return JSON.parse(execFileSync("kubectl", [...args, "exec", "-i", "deployment/evalflow-app-api", "--",
        "node", "--input-type=module"], { encoding: "utf8", timeout: 20_000, input: `
        const url = new URL("postgresql://localhost");
        url.hostname = process.env.PGHOST; url.port = process.env.PGPORT;
        url.username = encodeURIComponent(process.env.PGUSER);
        url.password = encodeURIComponent(process.env.PGPASSWORD);
        url.pathname = "/" + encodeURIComponent(process.env.PGDATABASE);
        process.env.DATABASE_URL = url.toString();
        const { prisma } = await import("./dist/db.js");
        try { ${source} } finally { await prisma.$disconnect(); }
    ` }).trim());
}
let peak = 0;
let last;
function replicas() {
    const deployment = JSON.parse(kube("get", "deployment", "evalflow-app-worker", "-o", "json"));
    const count = deployment.spec.replicas;
    assert(count <= 4, `Requested ${count} workers exceeds configured cap`);
    peak = Math.max(peak, count);
    if (count !== last) console.log(`Desired workers: ${count}`);
    last = count;
    return count;
}
async function until(label, check, timeout = 180_000) {
    const deadline = Date.now() + timeout;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
        await sleep(2000);
    }
}
function report() {
    return fixture(`
        const jobs = await prisma.job.findMany(${JSON.stringify({where:{id:{in:owned}},include:{_count:{select:{evals:true}}}})});
        console.log(JSON.stringify(jobs.map(j=>({id:j.id,status:j.status,attempts:j.attempts,evals:j._count.evals}))));
    `);
}
try {
    if (existsSync(stateFile)) {
        const previous = JSON.parse(readFileSync(stateFile, "utf8"));
        assert(Array.isArray(previous) && previous.every(id => /^[0-9a-f-]{36}$/.test(id)));
        fixture(`await prisma.job.deleteMany({where:{id:{in:${JSON.stringify(previous)}},status:{in:["completed","dead_letter"]}}});
            console.log("true");`);
        const remaining = fixture(`console.log(await prisma.job.count({where:{id:{in:${JSON.stringify(previous)}}}}));`);
        assert.equal(remaining, 0, "Previous demo has unfinished jobs; wait for recovery before rerunning");
        unlinkSync(stateFile);
    }
    assert.equal(fixture('console.log(await prisma.job.count({where:{status:{in:["queued","running"]}}}));'), 0,
        "Run this demo on an idle local queue");
    await until("idle workers scale to zero", () => replicas() === 0);
    const delayed = fixture(`
        const job = await prisma.job.create({data:{type:"retention_risk_analysis",input:{userId:"user_123"},
            attempts:1,maxAttempts:3,runAfter:new Date("2099-01-01")}});
        console.log(JSON.stringify(job.id));
    `);
    remember(delayed);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        assert.equal(replicas(), 0, "Delayed retry must not wake workers");
        await sleep(2000);
    }
    assert.equal(fixture(`console.log(Number((await prisma.$queryRawUnsafe(${JSON.stringify(query)}))[0].count));`), 0);
    console.log("PASS: future retry remains queued and leaves workers at zero over three polling intervals.");
    fixture(`await prisma.$executeRawUnsafe("UPDATE jobs SET run_after = CURRENT_TIMESTAMP WHERE id = $1::uuid", ${JSON.stringify(delayed)});
        console.log("true");`);
    await until("eligible retry wakes a worker and completes", () => {
        replicas();
        return report()[0].status === "completed";
    });
    assert.equal(report()[0].attempts, 2);
    assert.equal(report()[0].evals, 1);
    await until("retry finishes and idle cooldown reaches zero", () => replicas() === 0);
    console.log("PASS: changing retry eligibility wakes workers and completes the second attempt exactly once.");

    const burst = fixture(`
        const {loadDataset,readDatasetFile}=await import("./dist/datasets.js");
        await loadDataset(await readDatasetFile("datasets/retention-v1.json"));
        const cases = await prisma.datasetCase.findMany();
        const jobs = await prisma.$transaction(cases.map(item=>prisma.job.create({data:{
            type:"retention_risk_analysis",caseId:item.id,input:{userId:"user_123",mockConfig:{latencyMs:12000}},
            maxAttempts:3}})));
        console.log(JSON.stringify(jobs.map(j=>j.id)));
    `);
    remember(...burst);
    await until("burst scales to four workers", () => replicas() === 4);
    await until("all burst jobs complete", () => {
        replicas();
        return report().every(job => job.status === "completed");
    }, 240_000);
    for (const job of report()) assert.equal(job.evals, 1);
    for (const job of report().filter(job => job.id !== delayed)) assert.equal(job.attempts, 1);
    assert.equal(peak, 4);
    await until("burst drains and workers return to zero", () => replicas() === 0);
    console.log(`PASS: ${burst.length} slow mock jobs scale 0 → 4 → 0 with one attempt/eval per burst job.`);
    const scaler = JSON.parse(kube("get", "scaledobject", "evalflow-app-worker", "-o", "json"));
    assert(scaler.status.conditions.some(c => c.type === "Ready" && c.status === "True"));
} catch (error) {
    kube("get", "scaledobject,hpa,pods", "-o", "wide").split("\n").forEach(line => console.error(line));
    throw error;
} finally {
    if (owned.length) {
        const remaining = fixture(`
        await prisma.job.deleteMany({where:{id:{in:${JSON.stringify(owned)}},status:{in:["completed","dead_letter"]}}});
        console.log(JSON.stringify(await prisma.job.count({where:{id:{in:${JSON.stringify(owned)}}}})));
    `);
        if (remaining === 0) unlinkSync(stateFile);
    }
}
