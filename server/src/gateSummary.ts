import type { GateComparison } from "./gate.js";

function escapeMarkdown(value: string) {
    return value.replace(/[\\`*_{}\[\]()#!]/g, "\\$&")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\r|\n/g, " ").replace(/\|/g, "&#124;");
}

function signed(value: number, decimals = 0) {
    const rounded = Number(value.toFixed(decimals));
    return `${rounded > 0 ? "+" : ""}${rounded.toFixed(decimals)}`;
}

function row(cells: Array<string | number>) {
    return `| ${cells.join(" | ")} |`;
}

function aggregate(comparison: GateComparison, side: "baseline" | "candidate") {
    const passed = comparison.cases.filter((item) => item[side].outcome === "pass").length;
    const scores = comparison.cases.flatMap((item) => item[side].score === null ? [] : [item[side].score!]);
    return {
        passed,
        passRate: passed / comparison.cases.length * 100,
        scored: scores.length,
        meanScore: scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : null,
    };
}

export function renderGateSummary(comparison: GateComparison, runId: string) {
    const baseline = aggregate(comparison, "baseline");
    const candidate = aggregate(comparison, "candidate");
    const { regression, improvement, warning, unchanged } = comparison.summary;
    const mean = (value: number | null) => value === null ? "—" : value.toFixed(2);
    const meanDelta = baseline.meanScore === null || candidate.meanScore === null
        ? "—" : signed(candidate.meanScore - baseline.meanScore, 2);
    const lines = [
        "## EvalFlow regression check",
        "",
        `**Result: ${comparison.exitCode === 0 ? "PASS" : "FAIL"}** (exit ${comparison.exitCode}).`,
        "",
        `Dataset: ${escapeMarkdown(comparison.dataset.name)} v${comparison.dataset.version}.`,
        `Candidate run: ${escapeMarkdown(runId)}.`,
        "",
        `Regressions: **${regression}** · Improvements: **${improvement}** · `
            + `Warnings: **${warning}** · Unchanged: **${unchanged}**`,
        "",
        "| Setting | Baseline | Candidate |",
        "| --- | --- | --- |",
        ...(["promptVersion", "provider", "model"] as const).map((key) =>
            `| ${key} | ${escapeMarkdown(comparison.baseline[key])} | ${escapeMarkdown(comparison.candidate[key])} |`),
        "",
    ];
    for (const side of ["baseline", "candidate"] as const) {
        const config = comparison[side].mockConfig;
        if (config) lines.push(`**${side} mock settings:** ${escapeMarkdown(JSON.stringify(config))}`, "");
    }
    lines.push(
        "| Metric | Baseline | Candidate | Change |",
        "| --- | ---: | ---: | ---: |",
        `| Passed cases | ${baseline.passed} | ${candidate.passed} | ${signed(candidate.passed - baseline.passed)} |`,
        row(["Pass rate", `${baseline.passRate.toFixed(1)}%`, `${candidate.passRate.toFixed(1)}%`,
            `${signed(candidate.passRate - baseline.passRate, 1)} pp`]),
        `| Mean recorded score | ${mean(baseline.meanScore)} | ${mean(candidate.meanScore)} | ${meanDelta} |`,
        row(["Cases with recorded scores", baseline.scored, candidate.scored, signed(candidate.scored - baseline.scored)]),
        "",
        "Pass rate uses all cases. Mean recorded score excludes missing scores; — means unavailable.",
        "Changes are candidate minus baseline; pp means percentage points.",
        "",
    );
    for (const [change, heading] of [["regression", "Regressed cases"], ["warning", "Warnings"]] as const) {
        lines.push(`### ${heading}`, "");
        const cases = comparison.cases.filter((item) => item.change === change);
        if (cases.length === 0) {
            lines.push("None.", "");
            continue;
        }
        lines.push("| Case | Baseline outcome | Candidate outcome | Baseline score | Candidate score |",
            "| --- | --- | --- | ---: | ---: |");
        for (const item of cases) {
            lines.push(row([escapeMarkdown(item.caseName), item.baseline.outcome, item.candidate.outcome,
                mean(item.baseline.score), mean(item.candidate.score)]));
        }
        lines.push("");
    }
    lines.push("Any pass-to-fail regression blocks the gate. Warnings are reported without blocking.", "");
    return lines.join("\n");
}
