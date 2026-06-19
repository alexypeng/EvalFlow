import { RetentionAnalysisSchema } from "./types.js";

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
