import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRetentionPrompt, callLlm, mockModel, resolveLlm } from "../../src/llm.js";
import { CreateRunSchema, MockConfigSchema, type AnalyticsSnapshot } from "../../src/types.js";
import { parseLlmJson, validateRetentionOutput } from "../../src/evaluator.js";

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

describe("per-run mock failures", () => {
    it("keeps zero-rate configuration identical to the default mock", async () => {
        const normal = await callLlm("prompt", snapshot);
        const configured = await callLlm("prompt", snapshot, { caseId: "case-1", mockConfig: {} });
        expect(configured).toEqual(normal);
        expect(validateRetentionOutput(JSON.parse(normal.text)).success).toBe(true);
    });

    it("produces invalid JSON at rate 1 and still records token usage", async () => {
        const response = await callLlm("prompt", snapshot, { caseId: "case-1", mockConfig: { invalidJsonRate: 1 } });
        expect(parseLlmJson(response.text).validJson).toBe(false);
        expect(response.completionTokens).toBeGreaterThan(0);
        expect(response.totalTokens).toBe(response.promptTokens + response.completionTokens);
    });

    it.each([8, 6, 4])("changes the predicted label at rate 1 for NPS %s", async (npsScore) => {
        const data = { ...snapshot, retentionSummary: { ...snapshot.retentionSummary, npsScore } };
        const normal = JSON.parse((await callLlm("prompt", data)).text);
        const changed = JSON.parse((await callLlm("prompt", data, {
            caseId: "case-1", mockConfig: { wrongLabelRate: 1 },
        })).text);
        expect(changed.retentionRisk).not.toBe(normal.retentionRisk);
        expect(validateRetentionOutput(changed).success).toBe(true);
    });

    it("removes evidence and fails schema validation at rate 1", async () => {
        const response = await callLlm("prompt", snapshot, {
            caseId: "case-1", mockConfig: { missingEvidenceRate: 1 },
        });
        const parsed = parseLlmJson(response.text);
        expect(parsed.validJson).toBe(true);
        expect(validateRetentionOutput(parsed.parsed).success).toBe(false);
        expect(JSON.parse(response.text).evidence).toEqual([]);
    });

    it("keeps selected cases stable across retries and execution order, and changes them with the seed", async () => {
        const ids = Array.from({ length: 40 }, (_, i) => `case-${i}`);
        async function labels(order: string[], seed: string) {
            return Object.fromEntries(await Promise.all(order.map(async (caseId) => [
                caseId,
                JSON.parse((await callLlm("prompt", snapshot, {
                    caseId, mockConfig: { seed, wrongLabelRate: 0.5 },
                })).text).retentionRisk,
            ])));
        }
        const first = await labels(ids, "demo");
        expect(new Set(Object.values(first)).size).toBe(2);
        expect(await labels([...ids].reverse(), "demo")).toEqual(first);
        expect(await labels(ids, "other")).not.toEqual(first);
    });

    it("keeps label selection independent of the missing-evidence rate", async () => {
        const options = { caseId: "case-1", mockConfig: { seed: "demo", wrongLabelRate: 0.5 } };
        const first = JSON.parse((await callLlm("prompt", snapshot, options)).text);
        const second = JSON.parse((await callLlm("prompt", snapshot, {
            ...options, mockConfig: { ...options.mockConfig, missingEvidenceRate: 1 },
        })).text);
        expect(second.retentionRisk).toBe(first.retentionRisk);
    });

    it("adds the configured latency before returning the response", async () => {
        const startedAt = performance.now();
        await callLlm("prompt", snapshot, { caseId: "case-1", mockConfig: { latencyMs: 25 } });
        // Small tolerance for timer rounding; an omitted sleep returns in under a millisecond.
        expect(performance.now() - startedAt).toBeGreaterThanOrEqual(20);
    });

    it("rejects mock configuration on Gemini before making a provider request", async () => {
        vi.stubEnv("LLM_PROVIDER", "gemini");
        vi.stubEnv("GEMINI_API_KEY", "test-key");
        await expect(callLlm("prompt", snapshot, { caseId: "case-1", mockConfig: {} }))
            .rejects.toThrow("mockConfig requires the mock provider");
    });

    it("requires a case ID for explicitly configured mock calls", async () => {
        await expect(callLlm("prompt", snapshot, { mockConfig: {} })).rejects.toThrow("requires a case ID");
    });

    it.each([
        { wrongLabelRate: -0.1 }, { wrongLabelRate: 1.1 }, { invalidJsonRate: "0.5" },
        { missingEvidenceRate: NaN }, { latencyMs: -1 }, { latencyMs: 0.5 }, { latencyMs: 60_001 },
        { seed: "" }, { seed: "a".repeat(101) }, { wrongLableRate: 1 },
    ])("rejects invalid API configuration %j", (mockConfig) => {
        const result = CreateRunSchema.safeParse({ datasetName: "retention", datasetVersion: 1, mockConfig });
        expect(result.success).toBe(false);
    });

    it("fills in defaults for partial configuration", () => {
        expect(MockConfigSchema.parse({ wrongLabelRate: 0.25 })).toEqual({
            seed: "evalflow", wrongLabelRate: 0.25, invalidJsonRate: 0, missingEvidenceRate: 0, latencyMs: 0,
        });
    });
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
        await expect(buildRetentionPrompt("case_user", snapshot, "v999")).rejects.toThrow(/Unknown prompt version/);
        await expect(buildRetentionPrompt("case_user", snapshot, "../v1")).rejects.toThrow();
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
