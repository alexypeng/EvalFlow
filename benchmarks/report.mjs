export function percentile(values, fraction) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const position = (sorted.length - 1) * fraction;
    const lower = Math.floor(position);
    return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

function distribution(values) {
    return { samples: values.length, p50: percentile(values, 0.5), p99: percentile(values, 0.99) };
}

export function summarize(trial) {
    const issues = [...(trial.issues ?? [])];
    const counts = { completed: 0, dead_letter: 0, queued: 0, running: 0 };
    const total = [], queue = [], execution = [];
    const accepted = trial.submissions.filter((item) => !item.error);
    const byId = new Map(trial.jobs.map((job) => [job.id, job]));
    const acceptedIds = new Set(accepted.map((job) => job.id));
    if (trial.jobs.some((job) => !acceptedIds.has(job.id))) issues.push("Stored jobs exist without successful enqueue acknowledgement");
    if (byId.size !== trial.jobs.length) issues.push("Duplicate job records in report");
    if (accepted.length !== trial.config.jobs) issues.push("Not every scheduled submission was accepted");
    for (const submission of accepted) {
        const job = byId.get(submission.id);
        if (!job) { issues.push(`Missing job ${submission.id}`); continue; }
        if (!(job.status in counts)) { issues.push(`Unknown status ${job.status}`); continue; }
        counts[job.status]++;
        if (job.status !== "completed") continue;
        const created = Date.parse(job.createdAt), started = Date.parse(job.startedAt), ended = Date.parse(job.completedAt);
        if (![created, started, ended].every(Number.isFinite) || started < created || ended < started) {
            issues.push(`Invalid timestamps for ${job.id}`);
            continue;
        }
        total.push(ended - created); queue.push(started - created); execution.push(ended - started);
        if (job.attempts !== 1 || job.evaluations !== 1) issues.push(`Unexpected attempts/evaluations for ${job.id}`);
    }
    if (counts.completed !== trial.config.jobs) issues.push("Not all scheduled jobs completed successfully");
    const start = Date.parse(trial.startedAt);
    if (trial.samples.some((sample) => sample.databaseAt &&
        Math.abs(Date.parse(sample.databaseAt) - start - sample.offsetMs) > 1000)) {
        issues.push("Database wall clock diverged from monotonic elapsed time by over 1s; possible host/VM suspension or clock change");
    }
    const endOfArrivals = start + trial.config.jobs / trial.config.arrivalRate * 1000;
    const completions = trial.jobs.filter((job) => job.status === "completed" && job.completedAt);
    const terminalTimes = trial.jobs.filter((job) => ["completed", "dead_letter"].includes(job.status))
        .map((job) => Date.parse(job.completedAt)).filter(Number.isFinite);
    const finish = terminalTimes.length ? Math.max(...terminalTimes) : null;
    const durationSeconds = finish === null ? null : (finish - start) / 1000;
    const maxLagMs = Math.max(0, ...trial.submissions.map((job) => job.lagMs));
    if (maxLagMs > 250) issues.push("Producer scheduling lag exceeded 250ms; arrival rate was not controlled closely enough");
    return {
        workers: trial.config.workers, scheduled: trial.config.jobs, accepted: accepted.length, counts,
        valid: issues.length === 0, issues,
        completedPerSecondDuringArrivals: completions.filter((job) => Date.parse(job.completedAt) <= endOfArrivals).length /
            (trial.config.jobs / trial.config.arrivalRate),
        completedPerSecondIncludingDrain: durationSeconds > 0 ? counts.completed / durationSeconds : null,
        drainSeconds: finish === null ? null : Math.max(0, (finish - endOfArrivals) / 1000),
        peakQueuedSampled: Math.max(0, ...trial.samples.map((sample) => sample.queued)),
        maxProducerLagMs: maxLagMs,
        totalMs: distribution(total), queueMs: distribution(queue), executionMs: distribution(execution),
    };
}

export function markdown(report) {
    const number = (value, digits = 2) => value === null ? "n/a" : value.toFixed(digits);
    const lines = ["# Fixed-worker benchmark", "", `Captured: ${report.capturedAt}`, "",
        "Queue/worker benchmark: direct Postgres producer, mock provider, one job/second, 2000ms mock latency.",
        "One exploratory trial per worker count; workers are warmed before measurement. This excludes HTTP latency.", "",
        "| Workers | Completed | Completion/s during arrivals | Completion/s incl. drain | Total p50 ms | Total p99 ms | Queue p99 ms | Execution p99 ms | Drain s | Valid |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|---:|:---:|"];
    for (const summary of report.summaries) {
        lines.push(`| ${summary.workers} | ${summary.counts.completed}/${summary.scheduled} | ` +
            `${number(summary.completedPerSecondDuringArrivals)} | ${number(summary.completedPerSecondIncludingDrain)} | ` +
            `${number(summary.totalMs.p50)} | ${number(summary.totalMs.p99)} | ${number(summary.queueMs.p99)} | ` +
            `${number(summary.executionMs.p99)} | ${number(summary.drainSeconds)} | ${summary.valid ? "yes" : "NO"} |`);
        for (const issue of summary.issues) lines.push(`\nTrial ${summary.workers}: ${issue}`);
    }
    lines.push("", "The workload offers only one job/second. A four-worker result near one completion/second does not measure its maximum capacity.",
        "p99 is interpolated over successful jobs; sample counts and failed/missing/pending jobs remain visible in the JSON report.",
        "Queue maxima are sampled, not exact. Queue/execution breakdowns require one attempt; invalid trials must not be compared.",
        "The local Docker host is shared with other services; these are exploratory results, not isolated or repeated capacity measurements.", "");
    return lines.join("\n");
}
