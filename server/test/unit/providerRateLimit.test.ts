import { expect, it, vi } from "vitest";
import { limitMockProvider, waitForProviderPermit } from "../../src/providerRateLimit.js";

it("leaves mock unlimited by default and accepts explicit true/false", () => {
    expect(limitMockProvider({})).toBe(false);
    expect(limitMockProvider({ RATE_LIMIT_MOCK: "false" })).toBe(false);
    expect(limitMockProvider({ RATE_LIMIT_MOCK: "true" })).toBe(true);
});

it.each(["", "1", "0", "TRUE", "yes"])("rejects ambiguous mock rate-limit setting %s", (value) => {
    expect(() => limitMockProvider({ RATE_LIMIT_MOCK: value })).toThrow("RATE_LIMIT_MOCK");
});

it("honors cancellation before attempting any database operation", async () => {
    const controller = new AbortController();
    controller.abort();
    const assertActive = vi.fn();
    await expect(waitForProviderPermit(
        { id: "unused", lockedBy: "unused", leaseToken: "unused" }, "mock",
        { signal: controller.signal, assertActive },
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(assertActive).not.toHaveBeenCalled();
});
