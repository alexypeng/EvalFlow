import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { summarize } from "../report.mjs";

test("first benchmark evidence remains reproducible and its original producer is preserved", async () => {
    const report = JSON.parse(await readFile(new URL(
        "../../docs/benchmarks/2026-10-18-fixed-workers.json", import.meta.url), "utf8"));
    const source = await readFile(new URL(
        "../../docs/benchmarks/sources/2026-10-18-fixed-workers-produce.mjs", import.meta.url));
    assert.deepEqual(report.summaries, report.trials.map(summarize));
    assert.equal(createHash("sha256").update(source).digest("hex"), report.environment.producerSha256);
});

test("capacity evidence recomputes all nine trials and repeated-rate aggregates", async () => {
    const { aggregateSweep } = await import("../sweepReport.mjs");
    const report = JSON.parse(await readFile(new URL(
        "../../docs/benchmarks/2026-10-18-capacity-sweep.json", import.meta.url), "utf8"));
    assert.equal(report.trials.length, 9);
    assert.deepEqual(report.summaries, report.trials.map(summarize));
    assert.deepEqual(report.aggregates, aggregateSweep(report));
    assert(report.aggregates.every((group) => group.comparable && group.validTrials === 3));
    const jobs = report.trials.flatMap((trial) => trial.jobs);
    assert.equal(jobs.length, 1080);
    assert.equal(new Set(jobs.map((job) => job.id)).size, 1080);
    assert(jobs.every((job) => job.status === "completed" && job.attempts === 1 && job.evaluations === 1));
});

test("idle polling evidence recomputes six paired trials, counters and restoration", async () => {
    const { summarizePolling, aggregatePolling, pollingMarkdown } = await import("../pollingReport.mjs");
    const report = JSON.parse(await readFile(new URL(
        "../../docs/benchmarks/2026-10-18-idle-polling.json", import.meta.url), "utf8"));
    assert.equal(report.plan.smoke, false);
    assert.equal(report.trials.length, 6);
    assert.equal(report.pollingSettingRestored, true);
    assert.equal(report.scalingSettingRestored, true);
    assert.deepEqual(report.summaries, report.trials.map(summarizePolling));
    assert.deepEqual(report.aggregates, aggregatePolling(report));
    assert(report.aggregates.every((group) => group.comparable && group.validTrials === 3));
    const jobs = report.trials.flatMap((trial) => trial.jobs);
    const warmup = report.trials.flatMap((trial) => trial.warmup);
    assert.equal(jobs.length, 180);
    assert.equal(warmup.length, 6);
    assert.equal(new Set([...jobs, ...warmup].map((job) => job.id)).size, 186);
    assert([...jobs, ...warmup].every((job) =>
        job.status === "completed" && job.attempts === 1 && job.evaluations === 1));
    assert.equal(await readFile(new URL(
        "../../docs/benchmarks/2026-10-18-idle-polling.md", import.meta.url), "utf8"), pollingMarkdown(report));
});

test("same-build wakeup evidence recomputes all conditions with a stable listener and restored settings", async () => {
    const { summarizeWakeup, aggregateWakeup, wakeupMarkdown } = await import("../wakeupReport.mjs");
    const report = JSON.parse(await readFile(new URL(
        "../../docs/benchmarks/2026-10-18-wakeup-comparison.json", import.meta.url), "utf8"));
    assert.equal(report.plan.smoke, false);
    assert.equal(report.trials.length, 9);
    assert.equal(report.pollingSettingRestored, true);
    assert.equal(report.wakeupSettingRestored, true);
    assert.equal(report.scalingSettingRestored, true);
    assert.deepEqual(report.summaries, report.trials.map(summarizeWakeup));
    assert.deepEqual(report.aggregates, aggregateWakeup(report));
    assert(report.aggregates.every((group) => group.comparable && group.validTrials === 3));
    const jobs = report.trials.flatMap((trial) => trial.jobs);
    const warmup = report.trials.flatMap((trial) => trial.warmup);
    assert.equal(jobs.length, 270);
    assert.equal(warmup.length, 9);
    assert.equal(new Set([...jobs, ...warmup].map((job) => job.id)).size, 279);
    assert([...jobs, ...warmup].every((job) =>
        job.status === "completed" && job.attempts === 1 && job.evaluations === 1));
    const imageIds = new Set(report.trials.map((trial) => trial.workerStates.before.pods[0].imageId));
    assert.equal(imageIds.size, 1);
    assert([...imageIds][0]);
    assert.equal(report.environment.notificationMigration.migration_name, "20261018000000_notify_queued_jobs");
    assert.equal(await readFile(new URL(
        "../../docs/benchmarks/2026-10-18-wakeup-comparison.md", import.meta.url), "utf8"), wakeupMarkdown(report));
});

test("one-Pod concurrency evidence recomputes nine controlled trials and restored settings", async () => {
    const { summarizeConcurrency, aggregateConcurrency, concurrencyMarkdown } = await import("../concurrencyReport.mjs");
    const report = JSON.parse(await readFile(new URL(
        "../../docs/benchmarks/2026-10-18-concurrency.json", import.meta.url), "utf8"));
    assert.equal(report.plan.smoke, false);
    assert.equal(report.trials.length, 9);
    assert.equal(report.concurrencySettingRestored, true);
    assert.equal(report.scalingSettingRestored, true);
    assert.deepEqual(report.summaries, report.trials.map(summarizeConcurrency));
    assert.deepEqual(report.aggregates, aggregateConcurrency(report));
    assert(report.aggregates.every((group) => group.comparable && group.validTrials === 3));
    const jobs = report.trials.flatMap((trial) => trial.jobs);
    const warmup = report.trials.flatMap((trial) => trial.warmup);
    assert.equal(jobs.length, 810);
    assert.equal(warmup.length, 21);
    assert.equal(new Set([...jobs, ...warmup].map((job) => job.id)).size, 831);
    assert([...jobs, ...warmup].every((job) =>
        job.status === "completed" && job.attempts === 1 && job.evaluations === 1));
    assert.equal(new Set(report.trials.map((trial) => trial.workerStates.before.pods[0].imageId)).size, 1);
    for (const trial of report.trials) {
        assert.equal(trial.workerStates.before.settings.image, report.environment.image);
        assert.deepEqual(trial.workerStates.before.settings.resources, report.environment.resources);
        assert.equal(trial.warmup.length, trial.config.concurrency);
    }
    assert.equal(await readFile(new URL(
        "../../docs/benchmarks/2026-10-18-concurrency.md", import.meta.url), "utf8"), concurrencyMarkdown(report));
});
