import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { context, propagation, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { beginJobAttemptTrace, captureJobTrace, jobParentContext, queueWaitTiming } from "../../src/jobTracing.js";
import { startInMemoryTracing } from "../fixtures/inMemoryTracing.js";

const tracing = startInMemoryTracing();
afterAll(() => tracing.close());
beforeEach(() => tracing.exporter.reset());
const traceId = "aabbccddeeff00112233445566778899";
const spanId = "1122334455667788";
const saved = { traceParent: `00-${traceId}-${spanId}-01`, traceState: "vendor=example" };

it("captures only W3C trace fields, leaving absent context null and excluding baggage", () => {
    expect(captureJobTrace()).toEqual({ traceParent: null, traceState: null });
    const parent = propagation.setBaggage(jobParentContext(saved), propagation.createBaggage({
        private: { value: "not-persisted" },
    }));
    expect(context.with(parent, captureJobTrace)).toEqual(saved);
});

it.each([null, "bad context", `00-${"0".repeat(32)}-${spanId}-01`])(
    "starts a fresh trace for missing/malformed context without inheriting another job: %s", (traceParent) => {
        const attempt = context.with(jobParentContext(saved), () => beginJobAttemptTrace({
            id: "old-job", attempts: 1, traceParent, traceState: null,
        }));
        expect(attempt.run(() => trace.getSpanContext(context.active())?.traceId)).not.toBe(traceId);
        attempt.finish("completed");
        expect(tracing.exporter.getFinishedSpans()[0].parentSpanContext).toBeUndefined();
    },
);

it("uses distinct attempt spans under the same persisted parent and records each outcome once", () => {
    const first = beginJobAttemptTrace({ ...saved, id: "job", attempts: 1 });
    const second = beginJobAttemptTrace({ ...saved, id: "job", attempts: 2 });
    first.finish("retried");
    second.finish("completed");
    second.finish("lease_lost");
    const spans = tracing.exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);
    expect(spans.every((span) => span.spanContext().traceId === traceId)).toBe(true);
    expect(spans.every((span) => span.parentSpanContext?.spanId === spanId)).toBe(true);
    expect(spans[0].spanContext().spanId).not.toBe(spans[1].spanContext().spanId);
    expect(spans.map((span) => span.attributes["job.attempt"])).toEqual([1, 2]);
    expect(spans.map((span) => span.attributes["job.outcome"])).toEqual(["retried", "completed"]);
    expect(spans.map((span) => span.status.code)).toEqual([SpanStatusCode.ERROR, SpanStatusCode.OK]);
});

it("keeps concurrent async operations in their own job contexts and preserves errors", async () => {
    const another = { ...saved, traceParent: `00-${"b".repeat(32)}-${spanId}-01` };
    const attempts = [saved, another].map((parent, i) =>
        beginJobAttemptTrace({ ...parent, id: String(i), attempts: 1 }),
    );
    const ids = await Promise.all(attempts.map((attempt) => attempt.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return trace.getSpanContext(context.active())?.traceId;
    })));
    expect(ids).toEqual([traceId, "b".repeat(32)]);
    const error = new Error("original operation error");
    await expect(attempts[0].run(async () => { throw error; })).rejects.toBe(error);
    attempts.forEach((attempt) => attempt.finish("unconfirmed"));
    expect(trace.getSpanContext(context.active())).toBeUndefined();
});

it("retains an unsampled parent without exporting an attempt span", () => {
    const attempt = beginJobAttemptTrace({
        ...saved, traceParent: saved.traceParent.slice(0, -2) + "00", id: "job", attempts: 1,
    });
    expect(attempt.run(captureJobTrace).traceParent).toMatch(new RegExp(`^00-${traceId}-[a-f0-9]{16}-00$`));
    attempt.finish("completed");
    expect(tracing.exporter.getFinishedSpans()).toHaveLength(0);
});

const queuedAt = new Date("2026-10-16T00:00:00Z");
const timing = {
    queuedAt,
    runAfter: new Date(queuedAt.getTime() + 2000),
    startedAt: new Date(queuedAt.getTime() + 5000),
};

it("records the historical queued interval and makes processing its child despite worker clock skew", () => {
    vi.spyOn(Date, "now").mockReturnValue(queuedAt.getTime() + 3600000);
    try {
        const attempt = beginJobAttemptTrace({ ...saved, ...timing, id: "job", attempts: 2 });
        expect(tracing.exporter.getFinishedSpans()).toHaveLength(1);
        attempt.finish("completed");
        const [queue, processing] = tracing.exporter.getFinishedSpans();
        expect(queue.name).toBe("job.queue_wait");
        expect(queue.duration).toEqual([5, 0]);
        expect(queue.startTime).toEqual([queuedAt.getTime() / 1000, 0]);
        expect(queue.endTime).toEqual([timing.startedAt.getTime() / 1000, 0]);
        expect(queue.attributes).toMatchObject({
            "job.id": "job", "job.attempt": 2,
            "job.queue_wait_ms": 5000, "job.scheduled_delay_ms": 2000, "job.ready_wait_ms": 3000,
        });
        expect(queue.parentSpanContext?.spanId).toBe(spanId);
        expect(processing.parentSpanContext?.spanId).toBe(queue.spanContext().spanId);
        expect(processing.spanContext().traceId).toBe(queue.spanContext().traceId);
    } finally { vi.restoreAllMocks(); }
});

it.each([
    [-1000, 0, 5000], [0, 0, 5000], [2000, 2000, 3000], [6000, 5000, 0],
])("bounds the split for eligibility at %i ms", (due, delay, ready) => {
    expect(queueWaitTiming({ ...timing, runAfter: new Date(queuedAt.getTime() + due) })).toMatchObject({
        totalMs: 5000, scheduledDelayMs: delay, readyWaitMs: ready,
    });
});

it.each([
    {}, { ...timing, queuedAt: null }, { ...timing, queuedAt: new Date(NaN) },
    { ...timing, startedAt: new Date(queuedAt.getTime() - 1) }, { ...timing, runAfter: new Date(NaN) },
])("omits unknown/invalid intervals while still starting an attempt: %j", (times) => {
    expect(queueWaitTiming(times)).toBeNull();
    beginJobAttemptTrace({ ...saved, ...times, id: "job", attempts: 1 }).finish("completed");
    expect(tracing.exporter.getFinishedSpans().map((span) => span.name)).toEqual(["job.process"]);
});

it("records a measured zero interval and keeps a new root trace shared with processing", () => {
    beginJobAttemptTrace({
        traceParent: null, traceState: null, id: "job", attempts: 1,
        queuedAt, startedAt: queuedAt, runAfter: queuedAt,
    }).finish("completed");
    const [queue, processing] = tracing.exporter.getFinishedSpans();
    expect(queue.duration).toEqual([0, 0]);
    expect(queue.attributes["job.queue_wait_ms"]).toBe(0);
    expect(queue.parentSpanContext).toBeUndefined();
    expect(processing.parentSpanContext?.spanId).toBe(queue.spanContext().spanId);
    expect(processing.spanContext().traceId).toBe(queue.spanContext().traceId);
});

it("keeps a queue span and its processing unsampled together", () => {
    beginJobAttemptTrace({
        ...saved, ...timing, traceParent: saved.traceParent.slice(0, -2) + "00", id: "job", attempts: 1,
    }).finish("completed");
    expect(tracing.exporter.getFinishedSpans()).toHaveLength(0);
});
