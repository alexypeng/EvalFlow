import { afterAll, beforeEach, expect, it } from "vitest";
import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { beginJobAttemptTrace } from "../../src/jobTracing.js";
import { tracePipelineStep } from "../../src/pipelineTracing.js";
import { LeaseLostError } from "../../src/heartbeat.js";
import { startInMemoryTracing } from "../fixtures/inMemoryTracing.js";

const tracing = startInMemoryTracing();
afterAll(() => tracing.close());
beforeEach(() => tracing.exporter.reset());
const saved = { traceParent: `00-${"a".repeat(32)}-1122334455667788-01`, traceState: null };

it("returns synchronous values unchanged and ends under the correct attempt", async () => {
    const attempt = beginJobAttemptTrace({ ...saved, id: "job", attempts: 1 });
    const result = { score: 80 };
    await expect(attempt.run(() => tracePipelineStep("evaluation.score", {}, (span) => {
        span.setAttribute("evalflow.eval.score", result.score);
        return result;
    }))).resolves.toBe(result);
    attempt.finish("completed");
    const [child, parent] = tracing.exporter.getFinishedSpans();
    expect(child.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(child.spanContext().traceId).toBe(parent.spanContext().traceId);
    expect(child.attributes).toMatchObject({ "step.outcome": "success", "evalflow.eval.score": 80 });
    expect(child.status.code).toBe(SpanStatusCode.OK);
});

it("ends the model span before a following database write, even when that write fails", async () => {
    const attempt = beginJobAttemptTrace({ ...saved, id: "job", attempts: 1 });
    const error = new Error("database write failed");
    const result = { text: "private-prompt-and-output" };
    let endBeforeWrite: [number, number] | undefined;
    await expect(attempt.run(async () => {
        expect(await tracePipelineStep("llm.call", { "gen_ai.request.model": "mock" }, async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return result;
        })).toBe(result);
        const finished = tracing.exporter.getFinishedSpans();
        expect(finished).toHaveLength(1);
        endBeforeWrite = [...finished[0].endTime];
        const database = trace.getTracer("test").startSpan("db.persist");
        await new Promise((resolve) => setTimeout(resolve, 5));
        database.end();
        throw error;
    })).rejects.toBe(error);
    attempt.finish("retried");
    const [llm, database, parent] = tracing.exporter.getFinishedSpans();
    expect(llm.kind).toBe(SpanKind.CLIENT);
    expect(llm.status.code).toBe(SpanStatusCode.OK);
    expect(llm.endTime).toEqual(endBeforeWrite);
    expect(llm.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(database.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(JSON.stringify(llm.attributes)).not.toContain(result.text);
});

it.each([
    { error: new Error("private failure details"), outcome: "error", async: false },
    { error: new Error("private failure details"), outcome: "error", async: true },
    { error: Object.assign(new Error("interrupted"), { name: "AbortError" }), outcome: "cancelled", async: true },
    { error: new LeaseLostError(), outcome: "lease_lost", async: true },
    { error: { reason: "private failure details" }, outcome: "error", async: false },
])("records $outcome without changing the original error (async=$async)", async ({ error, outcome, async }) => {
    await expect(tracePipelineStep("provider.permit_wait", {}, () => {
        if (async) return Promise.reject(error);
        throw error;
    })).rejects.toBe(error);
    const spans = tracing.exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["step.outcome"]).toBe(outcome);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(spans[0].attributes)).not.toContain("private failure details");
    expect(spans[0].events).toHaveLength(0);
});

it("keeps concurrent step contexts under their own attempt spans", async () => {
    const attempts = ["a", "b"].map((id) => beginJobAttemptTrace({
        ...saved, id, attempts: 1, traceParent: `00-${id.repeat(32)}-1122334455667788-01`,
    }));
    const observed = await Promise.all(attempts.map((attempt) => attempt.run(() =>
        tracePipelineStep("prompt.build", {}, async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            return trace.getSpanContext(context.active());
        }),
    )));
    attempts.forEach((attempt) => attempt.finish("completed"));
    const spans = tracing.exporter.getFinishedSpans();
    for (const current of observed) {
        const step = spans.find((span) => span.spanContext().spanId === current?.spanId)!;
        const parent = spans.find((span) => span.spanContext().spanId === step.parentSpanContext?.spanId)!;
        expect(step.name).toBe("prompt.build");
        expect(parent.name).toBe("job.process");
        expect(step.spanContext().traceId).toBe(parent.spanContext().traceId);
    }
    expect(observed[0]?.traceId).not.toBe(observed[1]?.traceId);
    expect(trace.getSpanContext(context.active())).toBeUndefined();
});

it("executes an unsampled operation without exporting any spans", async () => {
    const attempt = beginJobAttemptTrace({
        ...saved, traceParent: saved.traceParent.slice(0, -2) + "00", id: "job", attempts: 1,
    });
    await expect(attempt.run(() => tracePipelineStep("output.parse", {}, () => "result"))).resolves.toBe("result");
    attempt.finish("completed");
    expect(tracing.exporter.getFinishedSpans()).toHaveLength(0);
});
