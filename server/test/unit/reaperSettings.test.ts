import { expect, it } from "vitest";
import { reaperSettings } from "../../src/reaperSettings.js";

it("defaults to bounded scans every five seconds and accepts overrides", () => {
    expect(reaperSettings({})).toEqual({ intervalMs: 5000, batchSize: 100 });
    expect(reaperSettings({ REAPER_INTERVAL_MS: "20", REAPER_BATCH_SIZE: "2" })).toEqual({
        intervalMs: 20, batchSize: 2,
    });
});

it.each(["0", "-1", "1.5", "NaN", "", "2147483648"])("rejects unsafe scan interval %s", (value) => {
    expect(() => reaperSettings({ REAPER_INTERVAL_MS: value })).toThrow("REAPER_INTERVAL_MS");
});

it.each(["0", "-1", "1.5", "NaN", "", "1001"])("rejects unsafe batch size %s", (value) => {
    expect(() => reaperSettings({ REAPER_BATCH_SIZE: value })).toThrow("REAPER_BATCH_SIZE");
});
