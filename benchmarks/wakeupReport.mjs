import { percentile } from "./report.mjs";
import { summarizePolling } from "./pollingReport.mjs";
import { wakeupConditions } from "./scenarios.mjs";

export function summarizeWakeup(trial) {
    const summary = summarizePolling(trial);
    const issues = [...summary.issues];
    const expected = wakeupConditions.find((entry) => entry.condition === trial.config.condition);
    if (!expected || expected.wakeupMode !== trial.config.wakeupMode ||
        expected.pollIntervalMs !== trial.config.pollIntervalMs) issues.push("Wakeup condition does not match mode/interval");
    const states = trial.listenerStates;
    if (!Array.isArray(states?.before) || !Array.isArray(states?.after)) {
        issues.push("Missing listener registration/stability evidence");
    } else {
        if (trial.config.wakeupMode === "notify") {
            if (states.before.length !== 1 || states.before[0]?.state !== "listening") {
                issues.push("Notification listener was not registered cleanly before warmup");
            }
        } else if (states.before.length || states.after.length) issues.push("Polling worker unexpectedly opened a listener");
        if (JSON.stringify(states.before) !== JSON.stringify(states.after)) issues.push("Listener state changed during trial");
    }
    return { ...summary, wakeup: { condition: trial.config.condition, mode: trial.config.wakeupMode,
        idleIntervalMs: trial.config.pollIntervalMs }, issues, valid: issues.length === 0 };
}

export function aggregateWakeup(report) {
    const recognized = report.trials.every((trial) => report.plan.conditions.some((entry) =>
        entry.condition === trial.config.condition));
    return report.plan.conditions.map((condition) => {
        const entries = report.trials.map((trial, index) => ({ trial, summary: report.summaries[index] }))
            .filter(({ trial }) => trial.config.condition === condition.condition);
        const repetitions = new Set(entries.map(({ trial }) => trial.config.repetition));
        const compatible = recognized && entries.every(({ trial, summary }) => summary?.valid &&
            trial.config.wakeupMode === condition.wakeupMode && trial.config.pollIntervalMs === condition.pollIntervalMs &&
            trial.config.workers === 1 && trial.config.latencyMs === 0 && trial.config.jobs === report.plan.jobs &&
            trial.config.arrivalWindowMs === report.plan.arrivalWindowMs &&
            JSON.stringify(trial.config.scheduledOffsetsMs) === JSON.stringify(report.plan.scheduledOffsetsMs) &&
            trial.config.repetition >= 1 && trial.config.repetition <= report.plan.repetitions);
        const comparable = compatible && entries.length === report.plan.repetitions && repetitions.size === report.plan.repetitions;
        const stats = (pick) => {
            if (!comparable) return null;
            const values = entries.map(({ summary }) => pick(summary));
            return { min: Math.min(...values), median: percentile(values, 0.5), max: Math.max(...values) };
        };
        return { ...condition, observedTrials: entries.length, expectedTrials: report.plan.repetitions,
            validTrials: entries.filter(({ summary }) => summary?.valid).length, comparable,
            queueP50Ms: stats((s) => s.queueMs.p50), queueP99Ms: stats((s) => s.queueMs.p99),
            totalP99Ms: stats((s) => s.totalMs.p99), executionP99Ms: stats((s) => s.executionMs.p99),
            emptyQueriesPerSecond: stats((s) => s.polling.emptyPerSecond),
            allClaimsPerSecond: stats((s) => s.polling.totalPerSecond),
        };
    });
}

export function wakeupMarkdown(report) {
    const number = (value) => value === null || value === undefined ? "n/a" : value.toFixed(2);
    const stats = (value) => value ? `${number(value.median)} [${number(value.min)}–${number(value.max)}]` : "n/a";
    const lines = ["# Polling versus notification wakeups", "", `Captured: ${report.capturedAt}`, "",
        `Same migrated worker image, one worker/concurrency1, zero configured mock delay, ${report.plan.jobs} sparse jobs/trial.`,
        `${report.plan.repetitions} repetitions/condition with rotated order; identical seeded arrival offsets.`,
        "Cells show median [minimum–maximum] of individual trial metrics; trial p99 values are not pooled.", "",
        "| Condition | Valid trials | Queue p50 ms | Queue p99 ms | Total p99 ms | Execution p99 ms | Empty claim queries/s | All claims/s |",
        "|---|:---:|---:|---:|---:|---:|---:|---:|"];
    for (const group of aggregateWakeup(report)) lines.push(`| ${group.condition} | ` +
        `${group.validTrials}/${group.expectedTrials} | ${stats(group.queueP50Ms)} | ${stats(group.queueP99Ms)} | ` +
        `${stats(group.totalP99Ms)} | ${stats(group.executionP99Ms)} | ${stats(group.emptyQueriesPerSecond)} | ` +
        `${stats(group.allClaimsPerSecond)} |`);
    lines.push("", "## Individual trials", "",
        "| Order | Repeat | Condition | Completed | Queue p99 ms | Total p99 ms | Empty queries | Empty queries/s | Valid |",
        "|---:|---:|---|---:|---:|---:|---:|---:|:---:|");
    report.trials.forEach((trial, index) => {
        const s = report.summaries[index];
        lines.push(`| ${index + 1} | ${trial.config.repetition} | ${trial.config.condition} | ` +
            `${s.counts.completed}/${s.scheduled} | ${number(s.queueMs.p99)} | ${number(s.totalMs.p99)} | ` +
            `${s.polling?.empty ?? "n/a"} | ${number(s.polling?.emptyPerSecond)} | ${s.valid ? "yes" : "NO"} |`);
        for (const issue of s.issues) lines.push(`\nTrial ${index + 1}: ${issue}`);
    });
    lines.push("", "poll-1000/poll-100 use polling only. notify-1000 adds notifications with fixed 1000ms backup checks.",
        "The notification trigger is installed for all conditions; polling controls are freshly measured on the same image.",
        "The notify listener must register once before warmup and show no disconnect/re-registration through the trial.",
        "Claim counter snapshots exclude warmup and count only observed claim operations; producer, probe and other SQL are excluded.",
        "Query rates are not total database CPU/cost: trigger execution and notification connection/network overhead are not included.",
        "Notification mode still performs backup checks and needs one extra listener connection per worker process.",
        "This isolates existing idle-worker pickup; KEDA is paused, so it does not measure scale-from-zero or maximum capacity.",
        "Zero configured mock delay still includes tool/validation/persistence work; total latency excludes HTTP submission.",
        "Completion timestamps precede the final job/eval writes and transaction commit tail, as in earlier reports.",
        "Three local trials of 30 jobs provide a small observed range, not a confidence interval or stable population p99.",
        "Failed/incomplete trials retain their evidence; non-comparable groups have no aggregate latency/query values.", "");
    return lines.join("\n");
}
