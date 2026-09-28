import { afterEach, describe, expect, it, vi } from "vitest";
import {
    buildRetentionPrompt,
    callLlm,
    mockModel,
    resolveLlm,
} from "../../src/llm.js";
import type { AnalyticsSnapshot } from "../../src/types.js";

const snapshot: AnalyticsSnapshot = {
    events: [{ event: "login", daysAgo: 1 }],
    featureUsage: [],
    subscriptionHistory: [],
    retentionSummary: {
        userId: "case_user",
        activeDaysLast30: 9,
        activeDaysPrevious30: 9,
        supportTicketsLast30: 0,
        npsScore: 8,
    },
};

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("buildRetentionPrompt", () => {
    it("fills the v1 template with the user ID and snapshot", async () => {
        const prompt = await buildRetentionPrompt("case_user", snapshot, "v1");

        expect(prompt).toContain("User ID: case_user");
        expect(prompt).toContain(`Analytics data: ${JSON.stringify(snapshot)}`);
        expect(prompt).not.toContain("{{");
    });

    it("defaults to v1", async () => {
        expect(await buildRetentionPrompt("case_user", snapshot)).toBe(
            await buildRetentionPrompt("case_user", snapshot, "v1"),
        );
    });

    it("builds a different prompt for v2", async () => {
        const v1 = await buildRetentionPrompt("case_user", snapshot, "v1");
        const v2 = await buildRetentionPrompt("case_user", snapshot, "v2");

        expect(v2).not.toBe(v1);
        expect(v2).toContain("User ID: case_user");
        expect(v2).not.toContain("{{");
    });

    it("rejects unknown and path-like versions", async () => {
        await expect(
            buildRetentionPrompt("case_user", snapshot, "v999"),
        ).rejects.toThrow(/Unknown prompt version/);
        await expect(
            buildRetentionPrompt("case_user", snapshot, "../v1"),
        ).rejects.toThrow();
    });

    it("inserts data containing $ patterns literally", async () => {
        const prompt = await buildRetentionPrompt("user_$&", snapshot);

        expect(prompt).toContain("User ID: user_$&");
    });
});

describe("resolveLlm and callLlm", () => {
    it("use the mock by default", async () => {
        vi.stubEnv("LLM_PROVIDER", undefined);

        expect(resolveLlm()).toEqual({ provider: "mock", model: mockModel });

        const response = await callLlm("prompt", snapshot);
        expect(response.provider).toBe("mock");
        expect(response.model).toBe(mockModel);
    });

    it("report the mock when gemini is requested without an API key", async () => {
        vi.stubEnv("LLM_PROVIDER", "gemini");
        vi.stubEnv("GEMINI_API_KEY", "");

        const response = await callLlm("prompt", snapshot);
        expect(response.provider).toBe("mock");
        expect(response.model).toBe(mockModel);
    });

    it("resolve to gemini when the API key is set", () => {
        vi.stubEnv("LLM_PROVIDER", "gemini");
        vi.stubEnv("GEMINI_API_KEY", "test-key");

        expect(resolveLlm().provider).toBe("gemini");
    });
});
