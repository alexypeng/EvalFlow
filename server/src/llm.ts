import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AnalyticsSnapshot } from "./analyticsTools.js";

export type LlmResponse = {
    text: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
};

export function buildRetentionPrompt(
    userId: string,
    snapshot: AnalyticsSnapshot,
) {
    return [
        "You are an analytics agent performing retention risk analysis.",
        "Return only valid JSON matching this schema:",
        '{"summary":"string","retentionRisk":"low|medium|high","evidence": ["string"],"recommendedActions":["string"]}',
        `User ID: ${userId}`,
        `Analytics data: ${JSON.stringify(snapshot)}`,
    ].join("\n");
}

function estimateTokens(text: string) {
    return Math.max(1, Math.ceil(text.length / 4));
}

function getRiskLabel(snapshot: AnalyticsSnapshot) {
    const summary = snapshot.retentionSummary;
    const activityDrop =
        summary.activeDaysPrevious30 - summary.activeDaysLast30;

    if (
        summary.npsScore <= 4 ||
        summary.supportTicketsLast30 >= 2 ||
        activityDrop >= 10
    ) {
        return "high";
    }

    if (summary.npsScore <= 6 || activityDrop >= 5) {
        return "medium";
    }

    return "low";
}

export async function callLlm(
    prompt: string,
    snapshot: AnalyticsSnapshot,
): Promise<LlmResponse> {
    const provider = process.env.LLM_PROVIDER ?? "mock";

    if (provider === "gemini" && process.env.GEMINI_API_KEY) {
        const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = client.getGenerativeModel({
            model: "gemini-1.5-flash",
        });

        const result = await model.generateContent(prompt);
        const text = result.response.text();

        const promptTokens = estimateTokens(prompt);
        const completionTokens = estimateTokens(text);

        return {
            text,
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            estimatedCost: 0,
        };
    }

    const risk = getRiskLabel(snapshot);

    const text = JSON.stringify({
        summary: `User ${snapshot.retentionSummary.userId} has ${risk} retention risk based on recent
          activity, feature usage, subscription state, and NPS.`,
        retentionRisk: risk,
        evidence: [
            `Active days changed from ${snapshot.retentionSummary.activeDaysPrevious30} to
              ${snapshot.retentionSummary.activeDaysLast30}.`,
            `Support tickets in last 30 days: ${snapshot.retentionSummary.supportTicketsLast30}.`,
            `NPS score is ${snapshot.retentionSummary.npsScore}.`,
        ],
        recommendedActions:
            risk === "high"
                ? [
                      "Schedule customer success outreach.",
                      "Offer a workflow review focused on underused features.",
                  ]
                : risk === "medium"
                  ? [
                        "Send targeted enablement content.",
                        "Monitor usage trend over the next week.",
                    ]
                  : [
                        "Continue normal lifecycle messaging.",
                        "Invite the user to try advanced features.",
                    ],
    });

    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(text);

    return {
        text,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimatedCost: 0,
    };
}
