import { RetentionAnalysisSchema } from "./types.js";
import type { AnalyticsSnapshot } from "./analyticsTools.js";
import type { RetentionAnalysis } from "./types.js";

export function parseLlmJson(text: string) {
    const cleaned = text
        .trim()
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "");

    try {
        return {
            parsed: JSON.parse(cleaned) as unknown,
            validJson: true,
        };
    } catch {
        return {
            parsed: null,
            validJson: false,
        };
    }
}

export function validateRetentionOutput(parsed: unknown) {
    return RetentionAnalysisSchema.safeParse(parsed);
}

export function scoreRetentionAnalysis(params: {
    output: RetentionAnalysis;
    snapshot: AnalyticsSnapshot;
    validJson: boolean;
    hasRequiredFields: boolean;
}) {
    const evidenceIncluded = params.output.evidence.length > 0;

    const evidenceText = params.output.evidence.join(" ").toLowerCase();

    const summary = params.snapshot.retentionSummary;
    const activityDrop =
        summary.activeDaysPrevious30 - summary.activeDaysLast30;

    const evidenceSupported =
        evidenceText.includes(String(summary.activeDaysLast30)) ||
        evidenceText.includes(String(summary.activeDaysPrevious30)) ||
        evidenceText.includes(String(summary.supportTicketsLast30)) ||
        evidenceText.includes(String(summary.npsScore));

    const expectedRisk =
        summary.npsScore <= 4 ||
        summary.supportTicketsLast30 >= 2 ||
        activityDrop >= 10
            ? "high"
            : summary.npsScore <= 6 || activityDrop >= 5
              ? "medium"
              : "low";

    const reasonableRiskLabel = params.output.retentionRisk === expectedRisk;

    const taskCompletionScore =
        (params.validJson ? 20 : 0) +
        (params.hasRequiredFields ? 20 : 0) +
        (evidenceIncluded ? 20 : 0) +
        (evidenceSupported ? 20 : 0) +
        (reasonableRiskLabel ? 20 : 0);

    const notes = [
        evidenceSupported
            ? "Evidence references mock analytics data."
            : "Evidence does not clearly reference mock analytics data.",
        reasonableRiskLabel
            ? `Risk label matches rule-based expectation: ${expectedRisk}.`
            : `Risk label ${params.output.retentionRisk} differs from rule-
              based expectation: ${expectedRisk}.`,
    ].join(" ");

    return {
        validJson: params.validJson,
        hasRequiredFields: params.hasRequiredFields,
        evidenceIncluded,
        evidenceSupported,
        reasonableRiskLabel,
        taskCompletionScore,
        notes,
    };
}
