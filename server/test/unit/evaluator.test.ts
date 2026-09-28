import { describe, it, expect } from "vitest";
import { parseLlmJson } from "../../src/evaluator.js";

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

// TODO(ME), M1: write these against the ground-truth scoring; rewrite or
// delete the threshold stubs once the rules move into dataset labels.
// Tip: a `makeSnapshot(overrides)` helper with a neutral retentionSummary
// (nps 9, 0 tickets, equal active days) lets each test set one field.
describe("scoreRetentionAnalysis", () => {
    // Score is 5 checks x 20 points. Build an output that passes every check
    // and assert taskCompletionScore === 100 and all booleans true.
    it.todo("scores 100 when every check passes");

    // validJson and hasRequiredFields are passed straight through from params.
    // Flip each one to false and assert the score drops by exactly 20.
    it.todo("deducts 20 when validJson is false");
    it.todo("deducts 20 when hasRequiredFields is false");

    // evidenceIncluded is `evidence.length > 0`. The Zod schema requires at
    // least one item, but the function itself accepts [] (build the output
    // object directly, don't go through validateRetentionOutput).
    it.todo("deducts 20 when evidence is empty");

    // evidenceSupported checks whether the evidence text contains any of the
    // snapshot numbers (activeDaysLast30, activeDaysPrevious30,
    // supportTicketsLast30, npsScore). Test one positive case per field, and
    // one negative with evidence that mentions none of them.
    it.todo("marks evidence supported when it cites a snapshot number");
    it.todo("marks evidence unsupported when it cites no snapshot numbers");

    // Known weakness: it's a substring match, so npsScore 4 "matches"
    // evidence saying "14 days". Write a test that exposes this, then decide
    // whether to fix it (e.g. word-boundary regex) or mark it it.fails.
    it.todo("does not treat a number inside a larger number as support");

    // reasonableRiskLabel: output.retentionRisk must equal the rule-based
    // expectation. Assert the notes string mentions the expected label.
    it.todo("deducts 20 and explains in notes when the risk label is wrong");

    describe("expected risk thresholds", () => {
        // high if ANY of: npsScore <= 4, supportTicketsLast30 >= 2,
        //                 activityDrop >= 10   (drop = previous30 - last30)
        // medium if ANY of: npsScore <= 6, activityDrop >= 5
        // low otherwise.
        //
        // Test each boundary on both sides, e.g. nps 4 -> high, nps 5 ->
        // medium; drop 10 -> high, drop 9 -> medium; drop 5 -> medium,
        // drop 4 -> low. it.each works well here.
        it.todo("npsScore boundaries: 4 -> high, 5 and 6 -> medium, 7 -> low");
        it.todo("supportTicketsLast30 boundary: 2 -> high, 1 -> not high");
        it.todo("activityDrop boundaries: 10 -> high, 9 and 5 -> medium, 4 -> low");

        // Negative drop (usage went UP) should not raise risk.
        it.todo("treats increased activity as low risk");
    });
});
