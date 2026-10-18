import { percentile, summarize } from "./report.mjs";

export function parseClaimCounters(text) {
    const values = {};
    for (const line of text.split("\n")) {
        const match = /^evalflow_worker_claim_queries_total\{outcome="(claimed|empty|error)"\} (\S+)$/.exec(line);
        if (!match) continue;
        if (match[1] in values) throw new Error("Duplicate claim counter");
        const value = Number(match[2]);
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid claim counter");
        values[match[1]] = value;
    }
    if (["claimed", "empty", "error"].some((key) => !(key in values))) throw new Error("Missing claim counter");
    return values;
}

export function summarizePolling(trial) {
    const summary = summarize(trial);
    const issues = [...summary.issues];
    let polling = null;
    try {
        const { before, after } = trial.claimMetrics;
        const first = parseClaimCounters(before.text), last = parseClaimCounters(after.text);
        const seconds = (after.offsetMs - before.offsetMs) / 1000;
        if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("Invalid counter observation duration");
        const delta = Object.fromEntries(Object.keys(first).map((key) => [key, last[key] - first[key]]));
        if (Object.values(delta).some((value) => value < 0)) throw new Error("Claim counters reset during trial");
        if (delta.error !== 0) issues.push("Claim query errors occurred");
        if (delta.claimed !== trial.config.jobs) issues.push("Claimed count does not match measured jobs");
        polling = { intervalMs: trial.config.pollIntervalMs, observedSeconds: seconds, ...delta,
            emptyPerSecond: delta.empty / seconds, totalPerSecond: (delta.empty + delta.claimed + delta.error) / seconds };
    } catch (error) { issues.push(error.message); }
    if (trial.config.workers !== 1 || trial.config.latencyMs !== 0) issues.push("Polling comparison workload changed");
    const byId = new Map(trial.jobs.map((job) => [job.id, job]));
    for (let i = 1; i < trial.submissions.length; i++) {
        const previous = byId.get(trial.submissions[i - 1].id), current = byId.get(trial.submissions[i].id);
        if (!previous?.completedAt || !current || Date.parse(current.createdAt) <= Date.parse(previous.completedAt)) {
            issues.push("Arrivals overlapped execution; trial did not keep the worker idle between jobs"); break;
        }
    }
    return { ...summary, polling, issues, valid: issues.length === 0 };
}

export function aggregatePolling(report) {
    return report.plan.intervalsMs.map((intervalMs) => {
        const entries = report.trials.map((trial, index) => ({ trial, summary: report.summaries[index] }))
            .filter(({ trial }) => trial.config.pollIntervalMs === intervalMs);
        const repetitions = new Set(entries.map(({ trial }) => trial.config.repetition));
        const compatible = entries.every(({ trial, summary }) => summary?.valid &&
            trial.config.workers === 1 && trial.config.latencyMs === 0 && trial.config.jobs === report.plan.jobs &&
            trial.config.arrivalWindowMs === report.plan.arrivalWindowMs &&
            JSON.stringify(trial.config.scheduledOffsetsMs) === JSON.stringify(report.plan.scheduledOffsetsMs) &&
            trial.config.repetition >= 1 && trial.config.repetition <= report.plan.repetitions);
        const comparable = compatible && entries.length === report.plan.repetitions &&
            repetitions.size === report.plan.repetitions;
        const stats = (pick) => {
            if (!comparable) return null;
            const values = entries.map(({ summary }) => pick(summary));
            return { min: Math.min(...values), median: percentile(values, 0.5), max: Math.max(...values) };
        };
        return { intervalMs, observedTrials: entries.length, expectedTrials: report.plan.repetitions,
            validTrials: entries.filter(({ summary }) => summary?.valid).length, comparable,
            queueP50Ms: stats((s) => s.queueMs.p50), queueP99Ms: stats((s) => s.queueMs.p99),
            totalP99Ms: stats((s) => s.totalMs.p99), executionP99Ms: stats((s) => s.executionMs.p99),
            emptyQueriesPerSecond: stats((s) => s.polling.emptyPerSecond),
            allClaimsPerSecond: stats((s) => s.polling.totalPerSecond),
        };
    });
}

export function pollingMarkdown(report) {
    const number = (value) => value === null || value === undefined ? "n/a" : value.toFixed(2);
    const stats = (value) => value ? `${number(value.median)} [${number(value.min)}–${number(value.max)}]` : "n/a";
    const lines = ["# Idle polling comparison", "", `Captured: ${report.capturedAt}`, "",
        `One worker/concurrency1, zero mock delay, ${report.plan.jobs} seeded sparse arrivals per trial.`,
        `${report.plan.repetitions} paired repetitions, alternating interval order; same arrival offsets each time.`,
        "Cells show median [minimum–maximum] of trial metrics; p99 values are not pooled.", "",
        "| Poll ms | Valid trials | Queue p50 ms | Queue p99 ms | Total p99 ms | Execution p99 ms | Empty claim queries/s | All claims/s |",
        "|---:|:---:|---:|---:|---:|---:|---:|---:|"];
    for (const group of aggregatePolling(report)) lines.push(`| ${group.intervalMs} | ` +
        `${group.validTrials}/${group.expectedTrials} | ${stats(group.queueP50Ms)} | ${stats(group.queueP99Ms)} | ` +
        `${stats(group.totalP99Ms)} | ${stats(group.executionP99Ms)} | ${stats(group.emptyQueriesPerSecond)} | ` +
        `${stats(group.allClaimsPerSecond)} |`);
    lines.push("", "## Individual trials", "",
        "| Order | Repeat | Poll ms | Completed | Queue p99 ms | Total p99 ms | Empty queries | Empty queries/s | Valid |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|:---:|");
    report.trials.forEach((trial, index) => {
        const s = report.summaries[index];
        lines.push(`| ${index + 1} | ${trial.config.repetition} | ${trial.config.pollIntervalMs} | ` +
            `${s.counts.completed}/${s.scheduled} | ${number(s.queueMs.p99)} | ${number(s.totalMs.p99)} | ` +
            `${s.polling?.empty ?? "n/a"} | ${number(s.polling?.emptyPerSecond)} | ${s.valid ? "yes" : "NO"} |`);
        for (const issue of s.issues) lines.push(`\nTrial ${index + 1}: ${issue}`);
    });
    lines.push("", "Claim counters are sampled after warmup and at the end of the observation window.",
        "Empty claims each correspond to one successful queue claim query returning no job; health, producer and other SQL are excluded.",
        "The query rate is an observed count, not a direct CPU/cost measurement. Query errors, resets or worker replacement invalidate a trial.",
        "This is a sparse-arrival wakeup experiment on a shared local host, not a throughput-capacity measurement.",
        "Zero mock delay still includes tool calls, validation, tracing and persistence work. Queue maxima are sampled.",
        "Three paired trials provide a small observed range, not a confidence interval or stable population p99.", "");
    return lines.join("\n");
}
