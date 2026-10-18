// Recompute from raw trials rather than trusting the archived summary fields.
import { readFile } from "node:fs/promises";
import { summarize } from "./report.mjs";
import { aggregateSweep } from "./sweepReport.mjs";
import { summarizeWakeup, aggregateWakeup } from "./wakeupReport.mjs";
import { summarizeConcurrency, aggregateConcurrency } from "./concurrencyReport.mjs";

const specifications = [
    ["capacity", "capacity-sweep", summarize, aggregateSweep],
    ["wakeup", "wakeup-comparison", summarizeWakeup, aggregateWakeup],
    ["concurrency", "concurrency", summarizeConcurrency, aggregateConcurrency],
];
const data = {};
for (const [key, archive, summarizeTrial, aggregate] of specifications) {
    const report = JSON.parse(await readFile(new URL(`../docs/benchmarks/2026-10-18-${archive}.json`, import.meta.url)));
    const summaries = report.trials.map(summarizeTrial);
    if (summaries.some((summary) => !summary.valid)) throw new Error(`Invalid ${key} trial`);
    const groups = aggregate({ ...report, summaries });
    if (groups.some((group) => !group.comparable)) throw new Error(`Incomplete ${key} comparison`);
    data[key] = groups;
}
process.stdout.write(JSON.stringify(data));
