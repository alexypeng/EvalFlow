import { percentile } from "./report.mjs";

function range(values) {
    return values.length ? {
        min: Math.min(...values), median: percentile(values, 0.5), max: Math.max(...values),
    } : null;
}

export function aggregateSweep(report) {
    return report.plan.rates.map((arrivalRate) => {
        const entries = report.trials.map((trial, index) => ({ trial, summary: report.summaries[index] }))
            .filter(({ trial }) => trial.config.arrivalRate === arrivalRate);
        const compatible = entries.every(({ trial, summary }) => summary &&
            trial.config.workers === report.plan.workers && trial.config.latencyMs === report.plan.latencyMs &&
            trial.config.jobs / trial.config.arrivalRate === report.plan.durationSeconds);
        const repetitions = new Set(entries.map(({ trial }) => trial.config.repetition));
        const valid = entries.filter(({ summary }) => summary?.valid);
        const comparable = compatible && entries.length === report.plan.repetitions &&
            repetitions.size === report.plan.repetitions && valid.length === report.plan.repetitions &&
            entries.every(({ trial }) => Number.isInteger(trial.config.repetition) &&
                trial.config.repetition >= 1 && trial.config.repetition <= report.plan.repetitions);
        const statistic = (pick) => comparable ? range(valid.map(({ summary }) => pick(summary))) : null;
        return {
            arrivalRate, workers: report.plan.workers, expectedTrials: report.plan.repetitions,
            observedTrials: entries.length, validTrials: valid.length, comparable,
            completed: entries.reduce((sum, { summary }) => sum + (summary?.counts.completed ?? 0), 0),
            scheduled: entries.reduce((sum, { trial }) => sum + trial.config.jobs, 0),
            completedPerSecondDuringArrivals: statistic((s) => s.completedPerSecondDuringArrivals),
            completedPerSecondIncludingDrain: statistic((s) => s.completedPerSecondIncludingDrain),
            totalP99Ms: statistic((s) => s.totalMs.p99), queueP99Ms: statistic((s) => s.queueMs.p99),
            executionP99Ms: statistic((s) => s.executionMs.p99),
            peakQueuedSampled: statistic((s) => s.peakQueuedSampled), drainSeconds: statistic((s) => s.drainSeconds),
        };
    });
}

export function sweepMarkdown(report) {
    const number = (value) => value === null || value === undefined ? "n/a" : value.toFixed(2);
    const statistic = (value) => value ? `${number(value.median)} [${number(value.min)}–${number(value.max)}]` : "n/a";
    const groups = aggregateSweep(report);
    const lines = ["# Four-worker arrival-rate sweep", "", `Captured: ${report.capturedAt}`, "",
        `${report.plan.workers} fixed workers, concurrency 1, 2000ms mock latency; ${report.plan.durationSeconds}s of arrivals per trial.`,
        `${report.plan.repetitions} trials per rate; rotated order, warmup batch and full drain between trials.`,
        "Direct Postgres queue producer; HTTP and real-provider latency excluded.", "",
        "## Across repeated trials", "",
        "Each cell is the median [minimum–maximum] of trial-level measurements. Trial p99 values are not pooled.", "",
        "| Arrivals/s | Valid trials | Completed | Completion/s during arrivals | Completion/s incl. drain | Total p99 ms | Queue p99 ms | Execution p99 ms | Peak queued (sampled) | Drain s |",
        "|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
    for (const group of groups) lines.push(`| ${group.arrivalRate} | ${group.validTrials}/${group.expectedTrials} | ` +
        `${group.completed}/${group.scheduled} | ${statistic(group.completedPerSecondDuringArrivals)} | ` +
        `${statistic(group.completedPerSecondIncludingDrain)} | ${statistic(group.totalP99Ms)} | ` +
        `${statistic(group.queueP99Ms)} | ${statistic(group.executionP99Ms)} | ` +
        `${statistic(group.peakQueuedSampled)} | ${statistic(group.drainSeconds)} |`);
    lines.push("", "Aggregate statistics are withheld unless every planned repetition for that rate is present and valid.",
        "", "## Individual trials", "",
        "| Order | Repetition | Arrivals/s | Jobs | Completion/s incl. drain | Total p99 ms | Queue p99 ms | Drain s | Valid |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|:---:|");
    report.trials.forEach((trial, index) => {
        const s = report.summaries[index];
        lines.push(`| ${index + 1} | ${trial.config.repetition} | ${trial.config.arrivalRate} | ` +
            `${s.counts.completed}/${s.scheduled} | ${number(s.completedPerSecondIncludingDrain)} | ` +
            `${number(s.totalMs.p99)} | ${number(s.queueMs.p99)} | ${number(s.drainSeconds)} | ${s.valid ? "yes" : "NO"} |`);
        for (const issue of s.issues) lines.push(`\nTrial ${index + 1}: ${issue}`);
    });
    lines.push("", "These are repeated local results on a shared Docker host, not a production capacity guarantee.",
        "Finite arrival windows include startup-to-first-completion effects; the drain-inclusive rate includes the full backlog drain.",
        "Queue maxima are sampled. Timestamp latency ends at the completion marker before the final transaction commit tail.",
        "Three trials provide a small observed range, not a confidence interval or a stable population p99.", "");
    return lines.join("\n");
}
