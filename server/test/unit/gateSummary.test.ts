import { describe, expect, it } from "vitest";
import { compareBaselines } from "../../src/gate.js";
import { renderGateSummary } from "../../src/gateSummary.js";
import { MockConfigSchema } from "../../src/types.js";

function baseline(cases: Array<{ caseName: string; outcome: "pass" | "fail"; score: number | null }>) {
    return {
        formatVersion: 1,
        dataset: { name: "retention", version: 1 },
        run: {
            promptVersion: "v1", provider: "mock", model: "mock-rule-based", mockConfig: MockConfigSchema.parse({}),
        },
        cases,
    };
}

describe("renderGateSummary", () => {
    it("shows blocking regressions, nonblocking warnings and correctly denominated aggregate changes", () => {
        const reference = baseline([
            { caseName: "regressed", outcome: "pass", score: 100 },
            { caseName: "weaker", outcome: "pass", score: 100 },
            { caseName: "existing failure", outcome: "fail", score: null },
        ]);
        const candidate = baseline([
            { caseName: "regressed", outcome: "fail", score: null },
            { caseName: "weaker", outcome: "pass", score: 80 },
            { caseName: "existing failure", outcome: "fail", score: 80 },
        ]);
        const markdown = renderGateSummary(compareBaselines(reference, candidate), "run-123");
        expect(markdown).toContain("**Result: FAIL** (exit 1)");
        expect(markdown).toContain("| Passed cases | 2 | 1 | -1 |");
        expect(markdown).toContain("| Pass rate | 66.7% | 33.3% | -33.3 pp |");
        expect(markdown).toContain("| Mean recorded score | 100.00 | 80.00 | -20.00 |");
        expect(markdown).toContain("| Cases with recorded scores | 2 | 2 | 0 |");
        expect(markdown).toContain("| regressed | pass | fail | 100.00 | — |");
        expect(markdown).toContain("| weaker | pass | pass | 100.00 | 80.00 |");
        expect(markdown).toContain("Candidate run: run-123");
        expect(markdown).toContain("Warnings are reported without blocking");
    });

    it("shows a passing gate even when warnings and existing failures remain", () => {
        const reference = baseline([
            { caseName: "warning", outcome: "pass", score: 100 },
            { caseName: "failure", outcome: "fail", score: null },
        ]);
        const candidate = baseline([
            { caseName: "warning", outcome: "pass", score: 80 },
            { caseName: "failure", outcome: "fail", score: null },
        ]);
        const markdown = renderGateSummary(compareBaselines(reference, candidate), "run-123");
        expect(markdown).toContain("**Result: PASS** (exit 0)");
        expect(markdown).toContain("### Regressed cases\n\nNone.");
        expect(markdown).toContain("Warnings: **1**");
    });

    it("reports unavailable means instead of treating missing scores as zero", () => {
        const emptyScores = baseline([{ caseName: "failed", outcome: "fail", score: null }]);
        const markdown = renderGateSummary(compareBaselines(emptyScores, emptyScores), "run-123");
        expect(markdown).toContain("| Mean recorded score | — | — | — |");
        expect(markdown).toContain("| Pass rate | 0.0% | 0.0% | 0.0 pp |");
    });

    it("escapes case names and metadata so they cannot inject Markdown tables or HTML", () => {
        const name = "case|<script>\n*oops*";
        const reference = baseline([{ caseName: name, outcome: "pass", score: 100 }]);
        const candidate = baseline([{ caseName: name, outcome: "fail", score: 80 }]);
        reference.dataset.name = candidate.dataset.name = "data[link](url)|<img>";
        const markdown = renderGateSummary(compareBaselines(reference, candidate), "run-123");
        expect(markdown).not.toContain("<script>");
        expect(markdown).not.toContain("<img>");
        expect(markdown).toContain("case&#124;&lt;script&gt; \\*oops\\*");
        expect(markdown).toContain("data\\[link\\]\\(url\\)&#124;&lt;img&gt;");
    });
});
