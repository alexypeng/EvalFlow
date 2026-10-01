import { readFile } from "node:fs/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AnalyticsSnapshot } from "./analyticsTools.js";
import { PromptVersionSchema } from "./types.js";

export type LlmProvider = "mock" | "gemini";

export type LlmResponse = {
    text: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
    provider: LlmProvider;
    model: string;
};

export const geminiModel = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";

export const mockModel = "mock-rule-based";

export const defaultPromptVersion = "v1";

export function resolveLlm(): { provider: LlmProvider; model: string } {
    if (process.env.LLM_PROVIDER === "gemini" && process.env.GEMINI_API_KEY) {
        return { provider: "gemini", model: geminiModel };
    }

    return { provider: "mock", model: mockModel };
}

const promptDir = new URL("../prompts/retention/", import.meta.url);
const promptTemplates = new Map<string, string>();

async function loadPromptTemplate(version: string) {
    const cached = promptTemplates.get(version);

    if (cached !== undefined) return cached;

    PromptVersionSchema.parse(version);

    let template: string;

    try {
        template = await readFile(new URL(`${version}.md`, promptDir), "utf8");
    } catch {
        throw new Error(`Unknown prompt version "${version}"`);
    }

    promptTemplates.set(version, template.trim());

    return template.trim();
}

export async function promptVersionExists(version: string) {
    try {
        await loadPromptTemplate(version);
        return true;
    } catch {
        return false;
    }
}

export async function buildRetentionPrompt(
    userId: string,
    snapshot: AnalyticsSnapshot,
    promptVersion: string = defaultPromptVersion,
) {
    const template = await loadPromptTemplate(promptVersion);

    return template.replaceAll("{{userId}}", () => userId).replaceAll("{{snapshot}}", () => JSON.stringify(snapshot));
}

function estimateTokens(text: string) {
    return Math.max(1, Math.ceil(text.length / 4));
}

function getRiskLabel(snapshot: AnalyticsSnapshot) {
    const summary = snapshot.retentionSummary;
    const activityDrop = summary.activeDaysPrevious30 - summary.activeDaysLast30;

    if (summary.npsScore <= 4 || summary.supportTicketsLast30 >= 2 || activityDrop >= 10) {
        return "high";
    }

    if (summary.npsScore <= 6 || activityDrop >= 5) {
        return "medium";
    }

    return "low";
}

export async function callLlm(prompt: string, snapshot: AnalyticsSnapshot): Promise<LlmResponse> {
    const { provider, model: modelName } = resolveLlm();

    if (provider === "gemini") {
        const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
        const model = client.getGenerativeModel({
            model: modelName,
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
            provider,
            model: modelName,
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
                ? ["Schedule customer success outreach.", "Offer a workflow review focused on underused features."]
                : risk === "medium"
                  ? ["Send targeted enablement content.", "Monitor usage trend over the next week."]
                  : ["Continue normal lifecycle messaging.", "Invite the user to try advanced features."],
    });

    const promptTokens = estimateTokens(prompt);
    const completionTokens = estimateTokens(text);

    return {
        text,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        estimatedCost: 0,
        provider,
        model: modelName,
    };
}
