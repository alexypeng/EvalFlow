import { test } from "node:test";
import assert from "node:assert/strict";
import { scenario, wakeupConditions } from "../scenarios.mjs";
import { summarizeWakeup, aggregateWakeup, wakeupMarkdown } from "../wakeupReport.mjs";
const iso = (ms) => new Date(ms).toISOString();
const counters = (claimed, empty, error = 0) => ["claimed", "empty", "error"].map((key, index) =>
    `evalflow_worker_claim_queries_total{outcome="${key}"} ${[claimed, empty, error][index]}`).join("\n");
function trial(condition = "poll-1000", repetition = 1) {
    const plan = scenario(["--wakeup-smoke"]);
    const config = { ...plan.trials.find((entry) => entry.condition === condition), repetition };
    const events = config.wakeupMode === "notify" ? [{ at: iso(0), state: "listening" }] : [];
    return { config, startedAt: iso(0), issues: [], samples: [], listenerStates: { before: events, after: [...events] },
        submissions: config.scheduledOffsetsMs.map((offset, i) => ({ id: String(i), scheduledMs: offset, lagMs: 0 })),
        jobs: config.scheduledOffsetsMs.map((offset, i) => ({ id: String(i), status: "completed", attempts: 1,
            evaluations: 1, createdAt: iso(offset), startedAt: iso(offset + 20), completedAt: iso(offset + 40) })),
        claimMetrics: { before: { text: counters(1, 5), offsetMs: 0 },
            after: { text: counters(5, 25), offsetMs: config.arrivalWindowMs } },
    };
}
function report(smoke = true) {
    const plan = scenario([smoke ? "--wakeup-smoke" : "--wakeup"]);
    const trials = plan.trials.map((config) => {
        const value = trial(config.condition, config.repetition);
        if (!smoke) {
            value.config = { ...config };
            value.submissions = config.scheduledOffsetsMs.map((offset, i) => ({ id: String(i), scheduledMs: offset, lagMs: 0 }));
            value.jobs = config.scheduledOffsetsMs.map((offset, i) => ({ id: String(i), status: "completed", attempts: 1,
                evaluations: 1, createdAt: iso(offset), startedAt: iso(offset + 20), completedAt: iso(offset + 40) }));
            value.claimMetrics.after = { text: counters(31, 65), offsetMs: config.arrivalWindowMs };
        }
        return value;
    });
    return { capturedAt: iso(0), plan, trials, summaries: trials.map(summarizeWakeup) };
}

test("wakeup plan rotates all three conditions with the same sparse schedule and fixed worker", () => {
    const plan = scenario(["--wakeup"]);
    assert.equal(plan.trials.length, 9);
    assert.equal(plan.trials.reduce((sum, trial) => sum + trial.jobs, 0), 270);
    assert.deepEqual(plan.trials.map((trial) => trial.condition),
        ["poll-1000", "poll-100", "notify-1000", "poll-100", "notify-1000", "poll-1000", "notify-1000", "poll-1000", "poll-100"]);
    for (const trial of plan.trials) {
        assert.equal(trial.workers, 1); assert.equal(trial.latencyMs, 0);
        assert.deepEqual(trial.scheduledOffsetsMs, plan.scheduledOffsetsMs);
        assert.equal(trial.arrivalWindowMs, 62479);
    }
    assert(scenario(["--wakeup-smoke"]).smoke);
    assert.equal(scenario(["--polling"]).trials.length, 6);
});
test("requires notification registration and rejects disconnects/re-registration or unexpected polling listeners", () => {
    assert(summarizeWakeup(trial("notify-1000")).valid);
    assert(summarizeWakeup(trial("poll-1000")).valid);
    for (const change of [
        (t) => { t.listenerStates.before = []; },
        (t) => { t.listenerStates.after.push({ at: iso(1), state: "disconnected" }); },
        (t) => { t.listenerStates.before.push({ at: iso(1), state: "listening" }); },
        (t) => { delete t.listenerStates; },
        (t) => { t.config.pollIntervalMs = 100; },
    ]) {
        const t = trial("notify-1000"); change(t); assert(!summarizeWakeup(t).valid);
    }
    const t = trial();
    t.listenerStates.before = t.listenerStates.after = [{ at: iso(0), state: "listening" }];
    assert(!summarizeWakeup(t).valid);
});
test("retains inherited claim-counter, overlap and job failures", () => {
    for (const change of [
        (t) => { t.claimMetrics.after.text = counters(5, 25, 1); },
        (t) => { t.claimMetrics.after.text = counters(4, 25); },
        (t) => { t.jobs[0].completedAt = t.jobs[1].createdAt; },
        (t) => { t.jobs[0].evaluations = 2; },
    ]) {
        const t = trial("notify-1000"); change(t); assert(!summarizeWakeup(t).valid);
    }
});
test("groups by mode AND interval, keeping poll1000 separate from notify1000", () => {
    const value = report(false);
    const groups = aggregateWakeup(value);
    assert.equal(groups.length, 3);
    assert.deepEqual(groups.map((group) => group.condition), wakeupConditions.map((entry) => entry.condition));
    assert(groups.every((group) => group.comparable && group.validTrials === 3));
    assert(groups.every((group) => group.queueP99Ms.median === 20));
    assert(wakeupMarkdown(value).includes("one extra listener connection"));
});
test("withholds incomplete, duplicated, invalid or mixed-schedule aggregates", () => {
    for (const change of [
        (r) => { r.trials.pop(); r.summaries.pop(); },
        (r) => { r.trials[0].config.repetition = 2; },
        (r) => { r.summaries[0].valid = false; },
        (r) => { r.trials[0].config.scheduledOffsetsMs = [1]; },
        (r) => { r.trials[0].config.wakeupMode = "notify"; },
    ]) {
        const value = report(false); change(value);
        const groups = aggregateWakeup(value);
        assert(groups.some((group) => !group.comparable && group.queueP99Ms === null));
    }
});
