import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { AttemptOutcome } from "./workerMetrics.js";

export interface JobTraceContext {
    traceParent: string | null;
    traceState: string | null;
}

export function captureJobTrace(): JobTraceContext {
    const carrier: Record<string, string> = {};
    propagation.inject(context.active(), carrier);
    return { traceParent: carrier.traceparent ?? null, traceState: carrier.tracestate ?? null };
}

export function jobParentContext(job: JobTraceContext) {
    // Start from ROOT_CONTEXT so missing/malformed data cannot inherit another job's active trace.
    return propagation.extract(ROOT_CONTEXT, {
        ...(job.traceParent ? { traceparent: job.traceParent } : {}),
        ...(job.traceState ? { tracestate: job.traceState } : {}),
    });
}

export function beginJobAttemptTrace(job: JobTraceContext & { id: string; attempts: number }) {
    const parent = jobParentContext(job);
    const span = trace.getTracer("evalflow.jobs").startSpan("job.process", {
        kind: SpanKind.CONSUMER,
        attributes: { "job.id": job.id, "job.attempt": job.attempts },
    }, parent);
    const active = trace.setSpan(parent, span);
    let finished = false;
    return {
        run<T>(operation: () => T): T {
            return context.with(active, operation);
        },
        finish(outcome: AttemptOutcome) {
            if (finished) return;
            finished = true;
            span.setAttribute("job.outcome", outcome);
            span.setStatus({ code: outcome === "completed" ? SpanStatusCode.OK : SpanStatusCode.ERROR });
            span.end();
        },
    };
}
