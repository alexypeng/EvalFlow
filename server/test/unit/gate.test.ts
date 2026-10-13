import { describe, expect, it } from "vitest";
import { compareBaselines } from "../../src/gate.js";
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

describe("compareBaselines", () => {
    it("pairs by name across order changes and classifies all changes", () => {
        const reference = baseline([
            { caseName: "regressed", outcome: "pass", score: 100 },
            { caseName: "improved", outcome: "fail", score: 80 },
            { caseName: "weaker", outcome: "pass", score: 100 },
            { caseName: "still_wrong", outcome: "fail", score: null },
            { caseName: "equal", outcome: "pass", score: 100 },
        ]);
        const candidate = baseline([
            { caseName: "equal", outcome: "pass", score: 100 },
            { caseName: "still_wrong", outcome: "fail", score: 80 },
            { caseName: "weaker", outcome: "pass", score: 80 },
            { caseName: "improved", outcome: "pass", score: 100 },
            { caseName: "regressed", outcome: "fail", score: null },
        ]);
        candidate.run.promptVersion = "v2";
        const comparison = compareBaselines(reference, candidate);
        expect(comparison.summary).toEqual({ regression: 1, improvement: 1, warning: 1, unchanged: 2 });
        expect(comparison.exitCode).toBe(1);
        expect(comparison.cases.map((item) => item.caseName))
            .toEqual(["equal", "improved", "regressed", "still_wrong", "weaker"]);
        expect(comparison.cases.find((item) => item.caseName === "regressed")!.candidate.score).toBeNull();
    });

    it("allows warnings, existing failures and improvements without blocking", () => {
        const reference = baseline([
            { caseName: "warning", outcome: "pass", score: 100 },
            { caseName: "improvement", outcome: "fail", score: 80 },
            { caseName: "existing_failure", outcome: "fail", score: null },
        ]);
        const candidate = baseline([
            { caseName: "warning", outcome: "pass", score: 80 },
            { caseName: "improvement", outcome: "pass", score: 100 },
            { caseName: "existing_failure", outcome: "fail", score: null },
        ]);
        expect(compareBaselines(reference, candidate).exitCode).toBe(0);
    });

    it.each([{ name: "different", version: 1 }, { name: "retention", version: 2 }])(
        "rejects different datasets: %j", (dataset) => {
            const reference = baseline([{ caseName: "case", outcome: "pass", score: 100 }]);
            expect(() => compareBaselines(reference, { ...reference, dataset }))
                .toThrow("same dataset name and version");
        },
    );

    it("rejects missing and extra names even when the case counts match", () => {
        const reference = baseline([{ caseName: "original", outcome: "pass", score: 100 }]);
        const candidate = baseline([{ caseName: "replacement", outcome: "pass", score: 100 }]);
        expect(() => compareBaselines(reference, candidate))
            .toThrow("missing: original; extra: replacement");
    });

    it("rejects pending results and duplicate case names", () => {
        const reference = baseline([{ caseName: "case", outcome: "pass", score: 100 }]);
        const pending = { ...reference, cases: [{ caseName: "case", outcome: "pending", score: null }] };
        expect(() => compareBaselines(reference, pending)).toThrow();
        const duplicates = { ...reference, cases: [reference.cases[0], reference.cases[0]] };
        expect(() => compareBaselines(reference, duplicates)).toThrow();
    });
});
