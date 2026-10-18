import "dotenv/config";
import { z } from "zod";
import { LlmSelectionSchema, type LlmSelection } from "./types.js";

export const geminiModel = process.env.GEMINI_MODEL ?? "gemini-3.8-flash";
export const mockModel = "mock-rule-based";

// Resolution never silently changes providers when credentials are absent.
export function resolveLlm(saved?: LlmSelection): LlmSelection {
    if (saved) return LlmSelectionSchema.parse(saved);
    const provider = z.enum(["mock", "gemini"]).default("mock").parse(process.env.LLM_PROVIDER);
    return LlmSelectionSchema.parse({ provider, model: provider === "gemini" ? geminiModel : mockModel });
}

export function llmOptions() {
    const models = [...new Set([geminiModel, ...(process.env.GEMINI_MODELS ?? "").split(",")]
        .map((model) => model.trim()).filter(Boolean))];
    for (const model of models) LlmSelectionSchema.parse({ provider: "gemini", model });
    return {
        default: resolveLlm(),
        providers: [
            { provider: "mock" as const, models: [mockModel], available: true },
            { provider: "gemini" as const, models, available: Boolean(process.env.GEMINI_API_KEY) },
        ],
    };
}

export class LlmSelectionError extends Error {}

// Admission policy applies to new jobs, not retries of an already saved selection.
export function selectLlm(requested?: LlmSelection): LlmSelection {
    const selection = resolveLlm(requested);
    const configured = llmOptions().providers.find((item) => item.provider === selection.provider)!;
    if (!configured.models.includes(selection.model)) throw new LlmSelectionError("Model is not configured for this provider");
    if (!configured.available) throw new LlmSelectionError("Gemini requires GEMINI_API_KEY on the backend");
    return selection;
}

export function assertLlmCredentials(selection: LlmSelection) {
    if (selection.provider === "gemini" && !process.env.GEMINI_API_KEY) {
        throw new Error("Gemini requires GEMINI_API_KEY on the worker");
    }
}
