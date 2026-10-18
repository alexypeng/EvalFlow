import { test } from "node:test";
import assert from "node:assert/strict";
import { scenario } from "../scenarios.mjs";
import { aggregateSweep, sweepMarkdown } from "../sweepReport.mjs";

function fixture() {
    const plan = scenario(["--sweep"]);
    return { capturedAt: "2026-10-18T00:00:00Z", plan,
        trials: plan.trials.map((config) => ({ config })),
        summaries: plan.trials.map((config) => ({
            valid: true, issues: [], scheduled: config.jobs, counts: { completed: config.jobs },
            completedPerSecondDuringArrivals: config.arrivalRate + config.repetition / 100,
            completedPerSecondIncludingDrain: config.arrivalRate + config.repetition / 100,
            totalMs: { p99: config.arrivalRate * 1000 + config.repetition * 10 },
            queueMs: { p99: config.repetition * 10 }, executionMs: { p99: 2000 },
            peakQueuedSampled: config.repetition, drainSeconds: config.repetition,
        })),
    };
}

test("sweep preserves a 60s window with balanced rotated order and three repetitions per rate", () => {
    const plan = scenario(["--sweep"]);
    assert.deepEqual(plan.trials.map((t) => t.arrivalRate), [1, 2, 3, 2, 3, 1, 3, 1, 2]);
    assert.equal(plan.trials.reduce((sum, t) => sum + t.jobs, 0), 1080);
    for (const rate of [1, 2, 3]) {
        const trials = plan.trials.filter((t) => t.arrivalRate === rate);
        assert.deepEqual(trials.map((t) => t.repetition), [1, 2, 3]);
        for (const t of trials) {
            assert.equal(t.workers, 4); assert.equal(t.latencyMs, 2000);
            assert.equal(t.jobs / t.arrivalRate, 60);
        }
    }
});
test("smoke is explicitly marked and baseline defaults remain unchanged", () => {
    const smoke = scenario(["--sweep-smoke"]);
    assert(smoke.smoke);
    assert.equal(smoke.repetitions, 1);
    assert.deepEqual(smoke.trials.map((t) => t.jobs), [4, 8, 12]);
    assert.deepEqual(scenario([]).trials.map((t) => [t.workers, t.jobs, t.arrivalRate]),
        [[1, 60, 1], [2, 60, 1], [4, 60, 1]]);
    assert.deepEqual(scenario(["--jobs", "4"]).trials.map((t) => t.jobs), [4, 4, 4]);
    for (const args of [["--jobs", "0"], ["--jobs", "NaN"], ["--sweep", "--jobs", "4"], ["--unknown"]]) {
        assert.throws(() => scenario(args));
    }
});
test("aggregates rates separately as median/range of trial metrics, not pooled percentiles", () => {
    const report = fixture();
    const groups = aggregateSweep(report);
    assert.deepEqual(groups.map((g) => g.completed), [180, 360, 540]);
    assert(groups.every((g) => g.comparable));
    assert.deepEqual(groups[0].totalP99Ms, { min: 1010, median: 1020, max: 1030 });
    assert.deepEqual(groups[2].totalP99Ms, { min: 3010, median: 3020, max: 3030 });
    const text = sweepMarkdown(report);
    assert(text.includes("1020.00 [1010.00–1030.00]"));
    assert(text.includes("Trial p99 values are not pooled"));
    assert(text.includes("## Individual trials"));
});
test("withholds aggregates for failed or missing trials instead of hiding them", () => {
    const report = fixture();
    report.summaries[0].valid = false;
    report.summaries[0].issues.push("Lease expired");
    let group = aggregateSweep(report)[0];
    assert.equal(group.validTrials, 2);
    assert(!group.comparable);
    assert.equal(group.totalP99Ms, null);
    assert(sweepMarkdown(report).includes("Lease expired"));
    assert(sweepMarkdown(report).includes("NO"));
    report.trials.pop(); report.summaries.pop();
    group = aggregateSweep(report)[1];
    assert.equal(group.observedTrials, 2);
    assert(!group.comparable);
    assert.equal(group.totalP99Ms, null);
});
test("rejects mixed windows, duplicate repetitions and differing worker counts", () => {
    for (const change of [
        (report) => { report.trials[0].config.jobs = 30; },
        (report) => { report.trials[0].config.repetition = 2; },
        (report) => { report.trials[0].config.workers = 2; },
        (report) => { report.trials[0].config.latencyMs = 0; },
    ]) {
        const report = fixture(); change(report);
        assert(!aggregateSweep(report)[0].comparable);
    }
});
