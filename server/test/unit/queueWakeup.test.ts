import { EventEmitter } from "node:events";
import type { Client } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { createIdleWakeup, startQueueListener, workerWakeupSettings } from "../../src/queueWakeup.js";

afterEach(() => { vi.useRealTimers(); });

it("validates modes/intervals and fixes notification backup checks at one second", () => {
    expect(workerWakeupSettings({})).toEqual({ mode: "poll", idleIntervalMs: 2000 });
    expect(workerWakeupSettings({ POLL_INTERVAL_MS: "100" })).toEqual({ mode: "poll", idleIntervalMs: 100 });
    expect(workerWakeupSettings({ WORKER_WAKEUP_MODE: "notify", POLL_INTERVAL_MS: "60000" }))
        .toEqual({ mode: "notify", idleIntervalMs: 1000 });
    expect(() => workerWakeupSettings({ WORKER_WAKEUP_MODE: "other" })).toThrow();
    for (const value of ["0", "-1", "NaN", "1.5", "", "2147483648"]) {
        expect(() => workerWakeupSettings({ POLL_INTERVAL_MS: value })).toThrow();
    }
});

it("does not lose a wakeup during a claim or between an empty result and waiting", async () => {
    vi.useFakeTimers();
    const signal = new AbortController();
    const idle = createIdleWakeup(1000, signal.signal);
    const beforeClaim = idle.version();
    idle.wake();
    await idle.wait(beforeClaim);
    expect(vi.getTimerCount()).toBe(0);
});

it("wakes every idle slot, cleans waiters, and leaves later waits sleeping", async () => {
    vi.useFakeTimers();
    const signal = new AbortController();
    const idle = createIdleWakeup(1000, signal.signal);
    const done = vi.fn();
    const waits = Array.from({ length: 4 }, () => idle.wait(idle.version()).then(done));
    idle.wake();
    await Promise.all(waits);
    expect(done).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    const next = idle.wait(idle.version()).then(done);
    await vi.advanceTimersByTimeAsync(999);
    expect(done).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    await next;
    expect(done).toHaveBeenCalledTimes(5);
});

it("interrupts idle wait on shutdown and makes subsequent waits return immediately", async () => {
    vi.useFakeTimers();
    const signal = new AbortController();
    const idle = createIdleWakeup(60000, signal.signal);
    const waiting = idle.wait(idle.version());
    signal.abort();
    await waiting;
    await idle.wait(idle.version());
    expect(vi.getTimerCount()).toBe(0);
});

class FakeClient extends EventEmitter {
    connect = vi.fn(async () => {});
    query = vi.fn(async (_sql: string) => {});
    end = vi.fn(async () => { this.emit("end"); });
}
function listener(clients: FakeClient[], signal: AbortSignal, wake = vi.fn()) {
    let index = 0;
    const onState = vi.fn();
    const result = startQueueListener({ connectionString: undefined, signal, wake, onState,
        createClient: () => clients[index++] as unknown as Client });
    return { ...result, wake, onState };
}

it("LISTENs before rechecking; filters unrelated channels and closes once on shutdown", async () => {
    const controller = new AbortController(), client = new FakeClient();
    const run = listener([client], controller.signal);
    try {
        await vi.waitFor(() => expect(run.onState).toHaveBeenCalledWith("listening"));
        expect(client.query).toHaveBeenCalledWith("LISTEN evalflow_jobs");
        expect(run.wake).toHaveBeenCalledTimes(1);
        client.emit("notification", { channel: "other" });
        expect(run.wake).toHaveBeenCalledTimes(1);
        client.emit("notification", { channel: "evalflow_jobs" });
        expect(run.wake).toHaveBeenCalledTimes(2);
    } finally { controller.abort(); await run.closed; }
    expect(client.end).toHaveBeenCalledTimes(1);
    client.emit("notification", { channel: "evalflow_jobs" });
    expect(run.wake).toHaveBeenCalledTimes(2);
});

it.each(["error", "end"])("reconnects after %s and rechecks jobs after registering again", async (event) => {
    vi.useFakeTimers();
    const controller = new AbortController(), first = new FakeClient(), second = new FakeClient();
    const run = listener([first, second], controller.signal);
    try {
        await vi.advanceTimersByTimeAsync(0);
        expect(run.wake).toHaveBeenCalledTimes(1);
        first.emit(event);
        await vi.advanceTimersByTimeAsync(999);
        expect(second.connect).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(second.query).toHaveBeenCalledWith("LISTEN evalflow_jobs");
        expect(run.wake).toHaveBeenCalledTimes(2);
        expect(first.end).toHaveBeenCalledTimes(1);
    } finally { controller.abort(); await run.closed; }
});

it("backs off failed LISTEN and interrupts reconnect sleep on shutdown", async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), client = new FakeClient();
    client.query.mockRejectedValue(new Error("unavailable"));
    const run = listener([client], controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.wake).not.toHaveBeenCalled();
    expect(run.onState).toHaveBeenCalledWith("disconnected");
    controller.abort();
    await run.closed;
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
});

it("closes a pending connection on shutdown without issuing LISTEN", async () => {
    const controller = new AbortController(), client = new FakeClient();
    let rejectConnect!: (error: Error) => void;
    client.connect.mockImplementation(() => new Promise((_resolve, reject) => { rejectConnect = reject; }));
    client.end.mockImplementation(async () => { rejectConnect(new Error("closed")); client.emit("end"); });
    const run = listener([client], controller.signal);
    controller.abort();
    await run.closed;
    expect(client.query).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledTimes(1);
});
