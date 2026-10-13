import { BaselineSchema } from "./baseline.js";
import { classifyChange, type CaseChange } from "./caseComparison.js";

export function compareBaselines(baselineInput: unknown, candidateInput: unknown) {
    const baseline = BaselineSchema.parse(baselineInput);
    const candidate = BaselineSchema.parse(candidateInput);
    if (baseline.dataset.name !== candidate.dataset.name || baseline.dataset.version !== candidate.dataset.version) {
        throw new Error("Baseline and candidate must use the same dataset name and version");
    }
    const byName = new Map(candidate.cases.map((item) => [item.caseName, item]));
    const baselineNames = new Set(baseline.cases.map((item) => item.caseName));
    const missing = baseline.cases.filter((item) => !byName.has(item.caseName)).map((item) => item.caseName).sort();
    const extra = candidate.cases.filter((item) => !baselineNames.has(item.caseName))
        .map((item) => item.caseName).sort();
    if (missing.length || extra.length) {
        const detail = `missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}`;
        throw new Error(`Case names do not match; ${detail}`);
    }

    const summary: Record<Exclude<CaseChange, "pending">, number> = {
        regression: 0, improvement: 0, warning: 0, unchanged: 0,
    };
    const cases = [...baseline.cases].sort((a, b) => a.caseName < b.caseName ? -1 : a.caseName > b.caseName ? 1 : 0)
        .map((item) => {
            const other = byName.get(item.caseName)!;
            const left = { outcome: item.outcome, score: item.score };
            const right = { outcome: other.outcome, score: other.score };
            const change = classifyChange(left, right);
            if (change === "pending") throw new Error("Gate requires finished case results");
            summary[change] += 1;
            return { caseName: item.caseName, baseline: left, candidate: right, change };
        });
    return {
        dataset: baseline.dataset,
        baseline: baseline.run,
        candidate: candidate.run,
        cases,
        summary,
        exitCode: summary.regression > 0 ? 1 : 0,
    };
}
