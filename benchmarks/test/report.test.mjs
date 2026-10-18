import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize, percentile, markdown } from "../report.mjs";
const iso = (seconds) => new Date(seconds * 1000).toISOString();
function fixture() {
    return {
        config: { workers: 1, jobs: 3, arrivalRate: 1, latencyMs: 2000 }, startedAt: iso(0), issues: [],
        submissions: [0, 1, 2].map((i) => ({ id: `j${i}`, lagMs: 0 })),
        jobs: [0, 1, 2].map((i) => ({ id: `j${i}`, status: "completed", attempts: 1, evaluations: 1,
            createdAt: iso(i), startedAt: iso(1 + 2 * i), completedAt: iso(3 + 2 * i) })),
        samples: [{ queued: 2 }],
    };
}
test("interpolates percentiles without mutating samples and preserves missing data", () => {
    const samples = [1000, 100];
    assert.equal(percentile(samples, 0.99), 991);
    assert.deepEqual(samples, [1000, 100]);
    assert.equal(percentile([], 0.99), null);
    assert.equal(percentile([12], 0.99), 12);
});
test("separates queue time from execution and uses the correct throughput windows", () => {
    const summary = summarize(fixture());
    assert(summary.valid);
    assert.equal(summary.totalMs.p50, 4000);
    assert.equal(summary.totalMs.p99, 4980);
    assert.equal(summary.queueMs.p99, 2980);
    assert.equal(summary.executionMs.p99, 2000);
    assert.equal(summary.completedPerSecondDuringArrivals, 1 / 3);
    assert.equal(summary.completedPerSecondIncludingDrain, 3 / 7);
    assert.equal(summary.drainSeconds, 4);
    assert.equal(summary.peakQueuedSampled, 2);
});
test("retains failed and pending counts and marks the trial invalid", () => {
    const trial = fixture();
    trial.jobs[1].status = "dead_letter";
    trial.jobs[2].status = "running";
    trial.jobs[2].completedAt = null;
    const summary = summarize(trial);
    assert.deepEqual(summary.counts, { completed: 1, dead_letter: 1, queued: 0, running: 1 });
    assert.equal(summary.totalMs.samples, 1);
    assert(!summary.valid);
});
test("does not hide failed submissions or accepted jobs missing from storage", () => {
    const trial = fixture();
    trial.submissions[0].error = "connection failed";
    trial.jobs = [];
    const summary = summarize(trial);
    assert.equal(summary.accepted, 2);
    assert(!summary.valid);
    assert(summary.issues.some((issue) => issue.includes("Missing job")));
    assert.equal(summary.totalMs.p99, null);
});
test("rejects retries, duplicate evaluations, backwards timestamps and uncontrolled producer lag", () => {
    for (const change of [
        (trial) => { trial.jobs[0].attempts = 2; },
        (trial) => { trial.jobs[0].evaluations = 2; },
        (trial) => { trial.jobs[0].startedAt = iso(-1); },
        (trial) => { trial.jobs[0].startedAt = null; },
        (trial) => { trial.submissions[0].lagMs = 500; },
        (trial) => { trial.issues.push("Worker count changed"); },
    ]) {
        const trial = fixture(); change(trial);
        assert(!summarize(trial).valid);
    }
});
test("an entirely failed trial has no successful latency samples", () => {
    const trial = fixture();
    for (const job of trial.jobs) job.status = "dead_letter";
    const summary = summarize(trial);
    assert.equal(summary.totalMs.p50, null);
    assert.equal(summary.totalMs.samples, 0);
    assert.equal(summary.completedPerSecondIncludingDrain, 0);
    assert(!summary.valid);
    const text = markdown({ capturedAt: iso(0), summaries: [summary] });
    assert(text.includes("n/a"));
    assert(text.includes("NO"));
});

test("rejects host/VM clock gaps even when worker Pods did not restart", () => {
    const trial = fixture();
    trial.samples = [{ queued: 2, databaseAt: iso(5), offsetMs: 5000 }];
    assert(summarize(trial).valid);
    trial.samples[0].databaseAt = iso(220);
    const summary = summarize(trial);
    assert(!summary.valid);
    assert(summary.issues.some((issue) => issue.includes("wall clock")));
});
