import { afterAll, beforeEach, expect, it } from "vitest";
import { context, propagation, ROOT_CONTEXT, SpanStatusCode, trace } from "@opentelemetry/api";
import { beginJobAttemptTrace, captureJobTrace, jobParentContext } from "../../src/jobTracing.js";
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
