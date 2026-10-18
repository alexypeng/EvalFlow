import { afterEach, expect, it, vi } from "vitest";
import { llmOptions, selectLlm, resolveLlm, geminiModel } from "../../src/llmConfig.js";
import { CreateRunSchema, JobInputSchema } from "../../src/types.js";

afterEach(() => vi.unstubAllEnvs());

it("advertises configured models and availability without exposing credentials", () => {
    vi.stubEnv("GEMINI_API_KEY", "test-not-a-secret");
    vi.stubEnv("GEMINI_MODELS", "gemini-custom, gemini-other,gemini-custom");
    expect(llmOptions().providers[1]).toEqual({
        provider: "gemini", available: true, models: [geminiModel, "gemini-custom", "gemini-other"],
    });
    expect(JSON.stringify(llmOptions())).not.toContain("test-not-a-secret");
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(llmOptions().providers[1].available).toBe(false);
    expect(selectLlm({ provider: "mock", model: "mock-rule-based" }).provider).toBe("mock");
});

it("validates provider/model pairs and rejects non-configured new selections", () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("GEMINI_MODELS", "gemini-allowed");
    expect(selectLlm({ provider: "gemini", model: "gemini-allowed" }).model).toBe("gemini-allowed");
    expect(() => selectLlm({ provider: "gemini", model: "gemini-disallowed" })).toThrow("not configured");
    for (const llm of [{ provider: "other", model: "anything" }, { provider: "mock", model: "gemini-allowed" },
        { provider: "gemini", model: "" }, { provider: "gemini", model: "bad model" }]) {
        expect(CreateRunSchema.safeParse({ datasetName: "retention", datasetVersion: 1, llm }).success).toBe(false);
        expect(JobInputSchema.safeParse({ userId: "test", llm }).success).toBe(false);
    }
});

it("does not reinterpret saved selections when defaults or the admission catalog change", () => {
    vi.stubEnv("LLM_PROVIDER", "mock");
    vi.stubEnv("GEMINI_MODELS", "gemini-new");
    expect(resolveLlm({ provider: "gemini", model: "gemini-original" }))
        .toEqual({ provider: "gemini", model: "gemini-original" });
    vi.stubEnv("GEMINI_API_KEY", "");
    expect(() => selectLlm({ provider: "gemini", model: geminiModel })).toThrow("GEMINI_API_KEY");
});
