export type CaseOutcome = "pass" | "fail" | "pending";
export type CaseChange = "regression" | "improvement" | "warning" | "unchanged" | "pending";
export type RunSide = { outcome: CaseOutcome; score: number | null };

export function classifyChange(baseline: RunSide, candidate: RunSide): CaseChange {
    if (baseline.outcome === "pending" || candidate.outcome === "pending") return "pending";
    if (baseline.outcome === "pass" && candidate.outcome === "fail") return "regression";
    if (baseline.outcome === "fail" && candidate.outcome === "pass") return "improvement";
    if (baseline.outcome === "pass" && candidate.outcome === "pass" && (candidate.score ?? 0) < (baseline.score ?? 0)) {
        return "warning";
    }
    return "unchanged";
}
