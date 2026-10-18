import { test } from "node:test";
import assert from "node:assert/strict";
import { scenario, pollingOffsets } from "../scenarios.mjs";
import { summarizePolling, parseClaimCounters, aggregatePolling, pollingMarkdown } from "../pollingReport.mjs";
const iso = (ms) => new Date(ms).toISOString();
const counters = (claimed, empty, error = 0) => ["claimed", "empty", "error"].map((key, index) =>
    `evalflow_worker_claim_queries_total{outcome="${key}"} ${[claimed, empty, error][index]}`).join("\n");
function trial(intervalMs = 1000, repetition = 1) {
    const plan = scenario(["--polling-smoke"]);
    const config = { ...plan.trials.find((t) => t.pollIntervalMs === intervalMs), repetition };
    return { config, startedAt: iso(0), issues: [], samples: [],
        submissions: config.scheduledOffsetsMs.map((offset, i) => ({ id: String(i), scheduledMs: offset, lagMs: 0 })),
        jobs: config.scheduledOffsetsMs.map((offset, i) => ({ id: String(i), status: "completed", attempts: 1,
            evaluations: 1, createdAt: iso(offset), startedAt: iso(offset + 500), completedAt: iso(offset + 520) })),
        claimMetrics: { before: { text: counters(1, 5), offsetMs: 0 },
            after: { text: counters(5, 25), offsetMs: config.arrivalWindowMs } },
    };
}
test("polling schedule is seeded, sparse and identical across paired conditions", () => {
    const plan = scenario(["--polling"]);
    assert.equal(plan.trials.length, 6);
    assert.deepEqual(plan.trials.map((t) => t.pollIntervalMs), [1000, 100, 100, 1000, 1000, 100]);
    assert.deepEqual(pollingOffsets(30), pollingOffsets(30));
    for (const t of plan.trials) {
        assert.equal(t.workers, 1); assert.equal(t.latencyMs, 0); assert.equal(t.jobs, 30);
        assert.deepEqual(t.scheduledOffsetsMs, plan.scheduledOffsetsMs);
        for (let i = 0; i < t.jobs; i++) {
            const gap = t.scheduledOffsetsMs[i] - (t.scheduledOffsetsMs[i - 1] ?? 0);
            assert(gap >= 1500 && gap < 2500);
        }
    }
});
test("counts measured queries excluding warmup and computes the actual observation rate", () => {
    const t = trial(), s = summarizePolling(t);
    assert(s.valid, s.issues.join(","));
    assert.equal(s.polling.claimed, 4); assert.equal(s.polling.empty, 20);
    assert.equal(s.polling.emptyPerSecond, 20 / (t.config.arrivalWindowMs / 1000));
    assert.equal(s.queueMs.p99, 500); assert.equal(s.executionMs.p99, 20);
});
test("rejects missing/reset/error/mismatched claim counters", () => {
    assert.throws(() => parseClaimCounters(""), /Missing/);
    assert.throws(() => parseClaimCounters(counters(1, 2) + "\n" + counters(1, 2)), /Duplicate/);
    assert.throws(() => parseClaimCounters(counters(1, -1)), /Invalid/);
    for (const change of [
        (t) => { t.claimMetrics.after.text = counters(0, 1); },
        (t) => { t.claimMetrics.after.text = counters(6, 25); },
        (t) => { t.claimMetrics.after.text = counters(5, 25, 1); },
        (t) => { t.claimMetrics.after.offsetMs = 0; },
        (t) => { delete t.claimMetrics; },
    ]) {
        const t = trial(); change(t); assert(!summarizePolling(t).valid);
    }
});
test("rejects overlapping arrivals that cease to be an idle-worker experiment", () => {
    const t = trial();
    t.jobs[0].completedAt = t.jobs[1].createdAt;
    assert(summarizePolling(t).issues.some((issue) => issue.includes("overlapped")));
});
test("keeps paired conditions separate and withholds incomplete or changed schedules", () => {
    const plan = scenario(["--polling-smoke"]);
    const trials = [trial(1000), trial(100)];
    const report = { capturedAt: iso(0), plan, trials, summaries: trials.map(summarizePolling) };
    assert(aggregatePolling(report).every((g) => g.comparable));
    assert.equal(aggregatePolling(report)[0].queueP99Ms.median, 500);
    assert(pollingMarkdown(report).includes("Empty claim queries/s"));
    report.trials[0].config.scheduledOffsetsMs = [1];
    assert(!aggregatePolling(report)[0].comparable);
    assert.equal(aggregatePolling(report)[0].queueP99Ms, null);
});
