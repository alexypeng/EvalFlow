// Sent over stdin to Node in the existing API Pod. No API or image changes are required.
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
const { z } = await import("zod");
const config = z.strictObject({
    workers: z.union([z.literal(1), z.literal(2), z.literal(4)]),
    jobs: z.number().int().min(4).max(600), arrivalRate: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    latencyMs: z.literal(2000), repetition: z.number().int().min(1).max(3).optional(),
    ids: z.array(z.uuid()), warmupIds: z.array(z.uuid()),
}).parse(JSON.parse(process.argv[2]));
if (config.ids.length !== config.jobs || config.warmupIds.length !== config.workers) throw new Error("ID count mismatch");
if (process.env.LLM_PROVIDER !== "mock") throw new Error("Benchmark requires mock provider");
const url = new URL("postgresql://localhost");
url.hostname = process.env.PGHOST; url.port = process.env.PGPORT;
url.username = encodeURIComponent(process.env.PGUSER); url.password = encodeURIComponent(process.env.PGPASSWORD);
url.pathname = "/" + encodeURIComponent(process.env.PGDATABASE);
process.env.DATABASE_URL = url.toString();
const moduleAt = (name) => import(pathToFileURL(`${process.cwd()}/dist/${name}.js`).href);
const { prisma } = await moduleAt("db");
const ids = config.ids;
const samples = [];
const issues = [];
let stopSampling = false;
let sampler;
try {
    if (await prisma.job.count({ where: { status: { in: ["queued", "running"] } } })) {
        throw new Error("Benchmark requires an idle queue; do not submit unrelated work during a trial");
    }
    const { loadDataset, readDatasetFile } = await moduleAt("datasets");
    await loadDataset(await readDatasetFile("datasets/retention-v1.json"));
    const cases = await prisma.datasetCase.findMany({ where: { dataset: { name: "retention", version: 1 } }, orderBy: { name: "asc" } });
    if (!cases.length) throw new Error("No dataset cases");
    const enqueue = (id, index) => {
        const item = cases[index % cases.length];
        return prisma.job.create({ data: { id, type: "retention_risk_analysis", caseId: item.id, maxAttempts: 1,
            input: { userId: item.snapshot.retentionSummary.userId, snapshot: item.snapshot, expectedRisk: item.expectedRisk,
                promptVersion: "v1", mockConfig: { seed: "benchmark-v1", latencyMs: config.latencyMs,
                    invalidJsonRate: 0, wrongLabelRate: 0, missingEvidenceRate: 0 } } } });
    };
    const rowsFor = (selected) => prisma.job.findMany({ where: { id: { in: selected } }, select: {
        id: true, status: true, attempts: true, createdAt: true, startedAt: true, completedAt: true,
        error: true, _count: { select: { evals: true } },
    } });
    const waitTerminal = async (selected, timeoutMs) => {
        const deadline = performance.now() + timeoutMs;
        while (performance.now() < deadline) {
            const rows = await rowsFor(selected);
            if (rows.length === selected.length && rows.every((job) => ["completed", "dead_letter"].includes(job.status))) return rows;
            await sleep(250);
        }
        issues.push("Timed out waiting for terminal jobs");
        return rowsFor(selected);
    };
    await Promise.all(config.warmupIds.map((id, index) => enqueue(id, index)));
    const warmup = await waitTerminal(config.warmupIds, 60_000);
    if (warmup.some((job) => job.status !== "completed" || job.attempts !== 1 || job._count.evals !== 1) ||
        warmup.length !== config.workers) throw new Error("Warmup failed; inspect fixture IDs in manifest");
    console.error(`Completed warmup batch of ${config.workers} jobs; scheduling ${config.jobs} jobs at ${config.arrivalRate}/s.`);
    const [{ now }] = await prisma.$queryRaw`SELECT clock_timestamp() AS now`;
    const began = performance.now();
    sampler = (async () => {
        let tick = 0;
        while (!stopSampling) {
            const rows = await rowsFor(ids);
            const [{ now: databaseAt }] = await prisma.$queryRaw`SELECT clock_timestamp() AS now`;
            const sample = { databaseAt, offsetMs: performance.now() - began, queued: 0, running: 0, completed: 0, dead_letter: 0 };
            for (const job of rows) sample[job.status]++;
            samples.push(sample);
            if (tick++ % 10 === 0) console.error(JSON.stringify(sample));
            await sleep(1000);
        }
    })().catch((error) => { issues.push(`Sampling failed: ${error.message}`); });
    const submissions = await Promise.all(ids.map(async (id, index) => {
        const scheduledMs = index / config.arrivalRate * 1000;
        await sleep(Math.max(0, began + scheduledMs - performance.now()));
        const sentMs = performance.now() - began;
        try {
            await enqueue(id, index);
            return { id, scheduledMs, sentMs, lagMs: Math.max(0, sentMs - scheduledMs), acknowledgedMs: performance.now() - began };
        } catch (error) {
            return { id, scheduledMs, sentMs, lagMs: Math.max(0, sentMs - scheduledMs), error: error.message };
        }
    }));
    await sleep(Math.max(0, began + config.jobs / config.arrivalRate * 1000 - performance.now()));
    const accepted = submissions.filter((job) => !job.error).map((job) => job.id);
    await waitTerminal(accepted, config.jobs * config.latencyMs + 60_000);
    const rows = await rowsFor(ids);
    stopSampling = true;
    await sampler;
    console.log(JSON.stringify({ config, startedAt: now, submissions, samples, issues,
        warmup: warmup.map(({ _count, ...job }) => ({ ...job, evaluations: _count.evals })),
        jobs: rows.map(({ _count, ...job }) => ({ ...job, evaluations: _count.evals })) }));
} finally {
    stopSampling = true;
    await sampler;
    await prisma.$disconnect();
}
