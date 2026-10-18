import assert from "node:assert/strict";

export function pollingOffsets(count) {
    let state = 20261018;
    let offset = 0;
    return Array.from({ length: count }, () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        offset += 1500 + Math.floor(state / 4294967296 * 1000);
        return offset;
    });
}

export function scenario(argv) {
    if (argv.length === 1 && ["--polling", "--polling-smoke"].includes(argv[0])) {
        const smoke = argv[0] === "--polling-smoke";
        const jobs = smoke ? 4 : 30;
        const repetitions = smoke ? 1 : 3;
        const scheduledOffsetsMs = pollingOffsets(jobs);
        const arrivalWindowMs = scheduledOffsetsMs.at(-1) + 1500;
        const trials = [];
        for (let repetition = 1; repetition <= repetitions; repetition++) {
            const intervals = repetition % 2 ? [1000, 100] : [100, 1000];
            for (const pollIntervalMs of intervals) trials.push({ workers: 1, jobs, latencyMs: 0, repetition,
                pollIntervalMs, arrivalRate: jobs / (arrivalWindowMs / 1000), scheduledOffsetsMs, arrivalWindowMs });
        }
        return { methodology: "queue-worker-idle-polling-v1", smoke, jobs, repetitions, intervalsMs: [1000, 100],
            workers: 1, latencyMs: 0, scheduledOffsetsMs, arrivalWindowMs, trials };
    }
    if (argv.length === 1 && ["--sweep", "--sweep-smoke"].includes(argv[0])) {
        const smoke = argv[0] === "--sweep-smoke";
        const durationSeconds = smoke ? 4 : 60;
        const repetitions = smoke ? 1 : 3;
        const rates = [1, 2, 3];
        const trials = [];
        for (let repetition = 1; repetition <= repetitions; repetition++) {
            const offset = repetition - 1;
            for (let position = 0; position < rates.length; position++) {
                const arrivalRate = rates[(position + offset) % rates.length];
                trials.push({ workers: 4, jobs: durationSeconds * arrivalRate, arrivalRate,
                    latencyMs: 2000, repetition });
            }
        }
        return { methodology: "queue-worker-arrival-sweep-v1", smoke, durationSeconds,
            repetitions, rates, workers: 4, latencyMs: 2000, trials };
    }
    assert(argv.length === 0 || (argv.length === 2 && argv[0] === "--jobs"),
        "Usage: node scripts/kind-benchmark.mjs [--jobs 60 | --sweep | --sweep-smoke]");
    const jobs = argv.length ? Number(argv[1]) : 60;
    assert(Number.isInteger(jobs) && jobs >= 4 && jobs <= 600, "Jobs must be an integer from 4 to 600");
    return { methodology: "queue-worker-fixed-v1", trials: [1, 2, 4].map((workers) => ({
        workers, jobs, arrivalRate: 1, latencyMs: 2000,
    })) };
}
