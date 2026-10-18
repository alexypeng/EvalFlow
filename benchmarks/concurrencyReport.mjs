import { summarize, percentile } from "./report.mjs";

export function summarizeConcurrency(trial) {
    const summary = summarize(trial);
    const issues = [...summary.issues];
    const c = trial.config.concurrency;
    if (![1, 2, 4].includes(c) || trial.config.workers !== 1 || trial.config.latencyMs !== 2000 ||
        trial.config.arrivalRate !== 3) issues.push("Concurrency workload differs from the controlled plan");
    // Completion markers precede final commit; this is observed pipeline overlap, not an exact active-slot metric.
    const events = trial.jobs.flatMap((job) => job.status === "completed" ? [
        { at: Date.parse(job.startedAt), delta: 1 }, { at: Date.parse(job.completedAt), delta: -1 },
    ] : []).sort((a, b) => a.at - b.at || a.delta - b.delta);
    let executing = 0, peakExecuting = 0;
    for (const event of events) { executing += event.delta; peakExecuting = Math.max(peakExecuting, executing); }
    if (peakExecuting !== c) issues.push("Observed pipeline overlap did not match configured concurrency");
    const states = trial.workerStates;
    const settings = [states?.before, ...(states?.observed ?? []), states?.after];
    if (settings.some((state) => state?.settings?.concurrency !== String(c) || state.settings.wakeupMode !== "poll" ||
        state.settings.pollIntervalMs !== "1000" || state.desired !== 1 || state.ready !== 1 || state.pods?.length !== 1)) {
        issues.push("Missing or changed fixed worker configuration evidence");
    }
    return { ...summary, concurrency: c, peakExecuting, issues, valid: issues.length === 0 };
}

export function aggregateConcurrency(report) {
    return report.plan.concurrencies.map((concurrency) => {
        const entries = report.trials.map((trial, i) => ({ trial, summary: report.summaries[i] }))
            .filter(({ trial }) => trial.config.concurrency === concurrency);
        const repetitions = new Set(entries.map(({ trial }) => trial.config.repetition));
        const compatible = entries.every(({ trial, summary }) => summary?.valid &&
            trial.config.workers === 1 && trial.config.jobs === report.plan.jobs &&
            trial.config.latencyMs === report.plan.latencyMs && trial.config.arrivalRate === report.plan.arrivalRate &&
            trial.config.jobs / trial.config.arrivalRate === report.plan.durationSeconds &&
            Number.isInteger(trial.config.repetition) && trial.config.repetition >= 1 &&
            trial.config.repetition <= report.plan.repetitions);
        const comparable = compatible && entries.length === report.plan.repetitions && repetitions.size === report.plan.repetitions;
        const stats = (pick) => {
            if (!comparable) return null;
            const values = entries.map(({ summary }) => pick(summary));
            return { min: Math.min(...values), median: percentile(values, 0.5), max: Math.max(...values) };
        };
        return { concurrency, observedTrials: entries.length, expectedTrials: report.plan.repetitions,
            validTrials: entries.filter(({ summary }) => summary?.valid).length, comparable,
            completedPerSecondDuringArrivals: stats((s) => s.completedPerSecondDuringArrivals),
            completedPerSecondIncludingDrain: stats((s) => s.completedPerSecondIncludingDrain),
            totalP50Ms: stats((s) => s.totalMs.p50), totalP99Ms: stats((s) => s.totalMs.p99),
            queueP99Ms: stats((s) => s.queueMs.p99), executionP99Ms: stats((s) => s.executionMs.p99),
            peakQueuedSampled: stats((s) => s.peakQueuedSampled), drainSeconds: stats((s) => s.drainSeconds),
        };
    });
}

export function concurrencyMarkdown(report) {
    const n = (value) => value === undefined || value === null ? "n/a" : value.toFixed(2);
    const stats = (value) => value ? `${n(value.median)} [${n(value.min)}–${n(value.max)}]` : "n/a";
    const lines = ["# One-worker concurrency comparison", "", `Captured: ${report.capturedAt}`, "",
        `One fixed worker Pod/process; 1/2/4 concurrent slots, 2000ms mock latency, 3 arrivals/s for ${report.plan.durationSeconds}s.`,
        `${report.plan.repetitions} rotated repetitions per setting, ${report.plan.jobs} measured jobs/trial; per-slot warmup and full drain.`,
        "Same image/resources, polling-only mode at 1000ms, no mock permits or trace export; HTTP submission excluded.",
        "Cells show median [minimum–maximum] of trial metrics; trial p99 values are not pooled.", "",
        "| Slots | Valid trials | Completion/s during arrivals | Completion/s incl. drain | Total p50 ms | Total p99 ms | Queue p99 ms | Execution p99 ms | Peak queued (sampled) | Drain s |",
        "|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
    for (const g of aggregateConcurrency(report)) lines.push(`| ${g.concurrency} | ${g.validTrials}/${g.expectedTrials} | ` +
        `${stats(g.completedPerSecondDuringArrivals)} | ${stats(g.completedPerSecondIncludingDrain)} | ` +
        `${stats(g.totalP50Ms)} | ${stats(g.totalP99Ms)} | ${stats(g.queueP99Ms)} | ${stats(g.executionP99Ms)} | ` +
        `${stats(g.peakQueuedSampled)} | ${stats(g.drainSeconds)} |`);
    lines.push("", "## Individual trials", "",
        "| Order | Repeat | Slots | Completed | Observed overlap | Completion/s incl. drain | Total p99 ms | Drain s | Valid |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|:---:|");
    report.trials.forEach((trial, i) => {
        const s = report.summaries[i];
        lines.push(`| ${i + 1} | ${trial.config.repetition} | ${trial.config.concurrency} | ` +
            `${s.counts.completed}/${s.scheduled} | ${s.peakExecuting} | ${n(s.completedPerSecondIncludingDrain)} | ` +
            `${n(s.totalMs.p99)} | ${n(s.drainSeconds)} | ${s.valid ? "yes" : "NO"} |`);
        for (const issue of s.issues) lines.push(`\nTrial ${i + 1}: ${issue}`);
    });
    lines.push("", "Ideal service rates before overhead are 0.5/1/2 jobs/s; 3 arrivals/s overload every setting.",
        "Arrival-window rates include initial pickup and in-flight work; drain-inclusive rates include the full batch and final partial wave.",
        "Observed overlap uses database start/completion markers and must reach the configured slot count.",
        "The completion marker precedes final writes/commit; timestamp latencies exclude that transaction tail.",
        "Three trials on a shared local Docker host give a small observed range, not a confidence interval or production capacity guarantee.",
        "This tests in-process concurrency with fixed resources; pool sizing, CPU saturation and claim contention are not independently isolated.",
        "KEDA is paused; process startup and per-slot warmup are excluded. Original concurrency/scaling settings are restored.", "");
    return lines.join("\n");
}
