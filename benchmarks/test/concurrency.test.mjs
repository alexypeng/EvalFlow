import { test } from "node:test";
import assert from "node:assert/strict";
import { scenario } from "../scenarios.mjs";
import { summarizeConcurrency, aggregateConcurrency, concurrencyMarkdown } from "../concurrencyReport.mjs";
const iso = (ms) => new Date(ms).toISOString();
function trial(concurrency = 1, repetition = 1, smoke = true) {
    const plan = scenario([smoke ? "--concurrency-smoke" : "--concurrency"]);
    const config = { ...plan.trials.find((entry) => entry.concurrency === concurrency), repetition };
    const starts = [];
    const jobs = Array.from({ length: config.jobs }, (_, index) => {
        const created = Math.floor(index / 3 * 1000);
        const start = Math.max(created + 500, (starts[index - concurrency] ?? -2000) + 2000);
        starts.push(start);
        return { id: String(index), status: "completed", attempts: 1, evaluations: 1,
            createdAt: iso(created), startedAt: iso(start), completedAt: iso(start + 2000) };
    });
    const state = { desired: 1, ready: 1, pods: [{ imageId: "same-image" }], settings: {
        concurrency: String(concurrency), wakeupMode: "poll", pollIntervalMs: "1000" } };
    return { config, startedAt: iso(0), issues: [], samples: [], jobs,
        workerStates: { before: state, after: state, observed: [state] },
        submissions: jobs.map((job, index) => ({ id: job.id, scheduledMs: index / 3 * 1000, lagMs: 0 })) };
}
function report(smoke = false) {
    const plan = scenario([smoke ? "--concurrency-smoke" : "--concurrency"]);
    const trials = plan.trials.map((entry) => trial(entry.concurrency, entry.repetition, smoke));
    return { capturedAt: iso(0), plan, trials, summaries: trials.map(summarizeConcurrency) };
}
test("concurrency plan fixes one worker and identical load with three rotated repetitions", () => {
    const plan = scenario(["--concurrency"]);
    assert.equal(plan.trials.length, 9);
    assert.equal(plan.trials.reduce((sum, entry) => sum + entry.jobs, 0), 810);
    assert.deepEqual(plan.trials.map((entry) => entry.concurrency), [1, 2, 4, 2, 4, 1, 4, 1, 2]);
    assert(plan.trials.every((entry) => entry.workers === 1 && entry.arrivalRate === 3 &&
        entry.latencyMs === 2000 && entry.jobs / entry.arrivalRate === 30));
    assert.equal(scenario(["--concurrency-smoke"]).trials.length, 3);
    assert.equal(scenario(["--wakeup"]).trials.length, 9);
});
test("observes expected pipeline overlap and uses full-drain throughput", () => {
    for (const concurrency of [1, 2, 4]) {
        const t = trial(concurrency), summary = summarizeConcurrency(t);
        assert(summary.valid, summary.issues.join(","));
        assert.equal(summary.peakExecuting, concurrency);
        assert.equal(summary.executionMs.p99, 2000);
        const end = Math.max(...t.jobs.map((job) => Date.parse(job.completedAt)));
        assert.equal(summary.completedPerSecondIncludingDrain, t.config.jobs / (end / 1000));
    }
});
test("rejects missing/mismatched settings, oversubscribed evidence and insufficient observed overlap", () => {
    for (const change of [
        (t) => { delete t.workerStates; },
        (t) => { t.workerStates.before.settings.concurrency = "2"; },
        (t) => { t.workerStates.before.settings.wakeupMode = "notify"; },
        (t) => { t.workerStates.before.ready = 0; },
        (t) => { t.config.concurrency = 4; },
        (t) => { t.config.arrivalRate = 1; },
    ]) {
        const t = trial(); change(t); assert(!summarizeConcurrency(t).valid);
    }
});
test("reports concurrency groups separately without pooling trial percentiles", () => {
    const value = report();
    const groups = aggregateConcurrency(value);
    assert.deepEqual(groups.map((group) => group.concurrency), [1, 2, 4]);
    assert(groups.every((group) => group.comparable && group.validTrials === 3));
    assert(groups[0].totalP99Ms.median > groups[2].totalP99Ms.median);
    assert(concurrencyMarkdown(value).includes("pool sizing, CPU saturation and claim contention"));
});
test("withholds aggregates for incomplete, invalid, mixed-load or duplicated repetitions", () => {
    for (const change of [
        (r) => { r.trials.pop(); r.summaries.pop(); },
        (r) => { r.summaries[0].valid = false; },
        (r) => { r.trials[0].config.jobs = 60; },
        (r) => { r.trials[0].config.repetition = 2; },
    ]) {
        const value = report(); change(value);
        assert(aggregateConcurrency(value).some((group) => !group.comparable && group.totalP99Ms === null));
    }
});
