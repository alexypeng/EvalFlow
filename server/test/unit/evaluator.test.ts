import { describe, it, expect } from "vitest";
import { parseLlmJson, scoreRetentionAnalysis } from "../../src/evaluator.js";
import type { AnalyticsSnapshot, RetentionAnalysis } from "../../src/types.js";

describe("parseLlmJson", () => {
    it("parses plain JSON", async () => {
        const parsed = parseLlmJson('{"a":1}');

        expect(parsed).toEqual({ validJson: true, parsed: { a: 1 } });
    });

    it("strips ```json fences", async () => {
        const parsed = parseLlmJson('```json\n{"a":1}\n```');

        expect(parsed).toEqual({ validJson: true, parsed: { a: 1 } });
    });

    it("strips bare ``` fences", async () => {
        const parsed = parseLlmJson('```{"a":1}```');
        expect(parsed).toEqual({ validJson: true, parsed: { a: 1 } });
    });

    it("tolerates surrounding whitespace", async () => {
        const parsed = parseLlmJson('    \n```{"a":1}```\n    ');
        expect(parsed).toEqual({ validJson: true, parsed: { a: 1 } });
    });

    it("returns validJson=false for invalid JSON instead of throwing", async () => {
        const parsed = parseLlmJson('{"a":');
        expect(parsed).toEqual({ validJson: false, parsed: null });
    });

    it("does not parse JSON after leading prose (known limitation)", async () => {
        const parsed = parseLlmJson('Here you go:\n```json\n{"a":1}\n```');
        expect(parsed).toEqual({ validJson: false, parsed: null });
    });
});

type Summary = Partial<AnalyticsSnapshot["retentionSummary"]>;
type RiskLevel = RetentionAnalysis["retentionRisk"];

// A customer whose numbers trigger no risk under the rule: NPS 9, no tickets,
// steady activity. Tests override only the fields they care about.
function makeSnapshot(summary: Summary = {}): AnalyticsSnapshot {
    return {
        events: [],
        featureUsage: [],
        subscriptionHistory: [],
        retentionSummary: {
            userId: "user_test",
            activeDaysLast30: 20,
            activeDaysPrevious30: 20,
            supportTicketsLast30: 0,
            npsScore: 9,
            ...summary,
        },
    };
}

// An answer that passes every check against makeSnapshot()'s defaults.
function makeOutput(overrides: Partial<RetentionAnalysis> = {}): RetentionAnalysis {
    return {
        summary: "Healthy user.",
        retentionRisk: "low",
        evidence: ["NPS score is 9."],
        recommendedActions: ["Keep going."],
        ...overrides,
    };
}

function score(
    options: {
        output?: RetentionAnalysis;
        snapshot?: AnalyticsSnapshot;
        validJson?: boolean;
        hasRequiredFields?: boolean;
        expectedRisk?: RiskLevel;
    } = {},
) {
    return scoreRetentionAnalysis({
        output: options.output ?? makeOutput(),
        snapshot: options.snapshot ?? makeSnapshot(),
        validJson: options.validJson ?? true,
        hasRequiredFields: options.hasRequiredFields ?? true,
        expectedRisk: options.expectedRisk,
    });
}

describe("scoreRetentionAnalysis", () => {
    it("scores 100 when every check passes", () => {
        const result = score();

        expect(result.taskCompletionScore).toBe(100);
        expect(result).toMatchObject({
            validJson: true,
            hasRequiredFields: true,
            evidenceIncluded: true,
            evidenceSupported: true,
            reasonableRiskLabel: true,
        });
    });

    it("deducts 20 when validJson is false", () => {
        expect(score({ validJson: false }).taskCompletionScore).toBe(80);
    });

    it("deducts 20 when hasRequiredFields is false", () => {
        expect(score({ hasRequiredFields: false }).taskCompletionScore).toBe(80);
    });

    it("deducts 20 when evidence is empty, plus 20 because nothing is cited", () => {
        const result = score({ output: makeOutput({ evidence: [] }) });

        expect(result.evidenceIncluded).toBe(false);
        expect(result.evidenceSupported).toBe(false);
        expect(result.taskCompletionScore).toBe(60);
    });

    describe("evidence support", () => {
        // Single, distinct digits so a match can only come from the intended field.
        const snapshot = makeSnapshot({
            activeDaysLast30: 7,
            activeDaysPrevious30: 8,
            supportTicketsLast30: 3,
            npsScore: 6,
        });

        it.each([
            ["activeDaysLast30", "Active on 7 days this month."],
            ["activeDaysPrevious30", "Active on 8 days last month."],
            ["supportTicketsLast30", "Opened 3 support tickets."],
            ["npsScore", "NPS score is 6."],
        ])("marks evidence supported when it cites %s", (_field, evidence) => {
            const result = score({ snapshot, output: makeOutput({ evidence: [evidence] }) });

            expect(result.evidenceSupported).toBe(true);
        });

        it("marks evidence unsupported when it cites no snapshot numbers", () => {
            const result = score({ snapshot, output: makeOutput({ evidence: ["Usage looks stable."] }) });

            expect(result.evidenceSupported).toBe(false);
            expect(result.notes).toContain("does not clearly reference");
        });

        // Known limitation: evidence is matched as a substring, so NPS 4 "matches"
        // "14 days". it.fails passes while the bug exists; once matching is fixed
        // (e.g. whole-number matching), this starts failing and should become it().
        it.fails("does not treat a number inside a larger number as support", () => {
            const result = score({
                snapshot: makeSnapshot({ npsScore: 4 }),
                output: makeOutput({ evidence: ["Last login was 14 days ago."] }),
            });

            expect(result.evidenceSupported).toBe(false);
        });
    });

    describe("risk label: answer key (run jobs)", () => {
        // makeSnapshot() is calm, so the rule would say "low". The answer key says
        // "high". Only the answer key may decide.
        it("grades against expectedRisk when one is given, not the rule", () => {
            const matchesKey = score({ expectedRisk: "high", output: makeOutput({ retentionRisk: "high" }) });
            const matchesRule = score({ expectedRisk: "high", output: makeOutput({ retentionRisk: "low" }) });

            expect(matchesKey.reasonableRiskLabel).toBe(true);
            expect(matchesKey.taskCompletionScore).toBe(100);
            expect(matchesRule.reasonableRiskLabel).toBe(false);
            expect(matchesRule.taskCompletionScore).toBe(80);
        });

        it("explains a wrong label against the dataset label in notes", () => {
            const result = score({ expectedRisk: "high", output: makeOutput({ retentionRisk: "low" }) });

            expect(result.notes).toContain("Risk label low differs from dataset label: high.");
        });
    });

    describe("risk label: rule fallback (dashboard jobs, no expectedRisk)", () => {
        // The rule's answer is the one label that earns the points.
        function ruleAnswer(summary: Summary): RiskLevel {
            const labels: RiskLevel[] = ["low", "medium", "high"];
            const credited = labels.filter(
                (label) =>
                    score({ snapshot: makeSnapshot(summary), output: makeOutput({ retentionRisk: label }) })
                        .reasonableRiskLabel,
            );

            expect(credited).toHaveLength(1);
            return credited[0];
        }

        it.each([
            [4, "high"],
            [5, "medium"],
            [6, "medium"],
            [7, "low"],
        ] as const)("npsScore %i -> %s", (npsScore, expected) => {
            expect(ruleAnswer({ npsScore })).toBe(expected);
        });

        it.each([
            [2, "high"],
            [1, "low"],
        ] as const)("supportTicketsLast30 %i -> %s", (supportTicketsLast30, expected) => {
            expect(ruleAnswer({ supportTicketsLast30 })).toBe(expected);
        });

        // Drop = previous 30 days - last 30 days, with previous fixed at 20.
        it.each([
            [10, "high"],
            [9, "medium"],
            [5, "medium"],
            [4, "low"],
        ] as const)("activity drop of %i -> %s", (drop, expected) => {
            expect(ruleAnswer({ activeDaysPrevious30: 20, activeDaysLast30: 20 - drop })).toBe(expected);
        });

        it("treats increased activity as low risk", () => {
            expect(ruleAnswer({ activeDaysPrevious30: 10, activeDaysLast30: 25 })).toBe("low");
        });

        it("explains a wrong label against the rule in notes", () => {
            const result = score({ output: makeOutput({ retentionRisk: "high" }) });

            expect(result.notes).toContain("Risk label high differs from rule-based expectation: low.");
        });
    });
});
