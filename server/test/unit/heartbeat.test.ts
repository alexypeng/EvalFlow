import { expect, it, vi } from "vitest";
import { startHeartbeat, LeaseLostError } from "../../src/heartbeat.js";
import { workerLeaseSettings } from "../../src/leaseSettings.js";

// Use real timers: the helper uses abortable node:timers/promises.

it("uses the agreed defaults and rejects unusable timing settings", () => {
    expect(workerLeaseSettings({})).toEqual({ leaseDurationMs: 60_000, heartbeatIntervalMs: 20_000 });
    for (const env of [
        { LEASE_DURATION_MS: "0" }, { LEASE_DURATION_MS: "Infinity" },
        { HEARTBEAT_INTERVAL_MS: "0" }, { HEARTBEAT_INTERVAL_MS: "60000" },
        { LEASE_DURATION_MS: "1.5" }, { HEARTBEAT_INTERVAL_MS: "bad" },
    ]) expect(() => workerLeaseSettings(env)).toThrow();
});

it("stops and drains an in-flight renewal without scheduling another", async () => {
    let resolve!: (owned: boolean) => void;
    let started!: () => void;
    const called = new Promise<void>((r) => { started = r; });
    const renew = vi.fn(() => { started(); return new Promise<boolean>((r) => { resolve = r; }); });
    const heartbeat = startHeartbeat(1, renew);
    await called;
    const stopping = heartbeat.stop();
    resolve(true);
    await stopping;
    expect(renew).toHaveBeenCalledTimes(1);
    expect(() => heartbeat.assertActive()).not.toThrow();
});

it.each([false, new Error("database unavailable")])("abandons work when renewal fails: %s", async (result) => {
    let called!: () => void;
    const observed = new Promise<void>((r) => { called = r; });
    const heartbeat = startHeartbeat(1, async () => {
        called();
        if (result instanceof Error) throw result;
        return result;
    });
    await observed;
    await heartbeat.stop();
    expect(() => heartbeat.assertActive()).toThrow(LeaseLostError);
});
