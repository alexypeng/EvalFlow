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

interface QueueTiming {
    queuedAt: Date | null;
    startedAt: Date;
    runAfter: Date;
}

export function queueWaitTiming(job: Partial<QueueTiming>) {
    if (!(job.queuedAt instanceof Date && job.startedAt instanceof Date && job.runAfter instanceof Date)) return null;
    const start = job.queuedAt.getTime();
    const end = job.startedAt.getTime();
    const due = job.runAfter.getTime();
    if (![start, end, due].every(Number.isFinite) || end < start) return null;
    const eligible = Math.min(end, Math.max(start, due));
    return {
        start: job.queuedAt,
        end: job.startedAt,
        totalMs: end - start,
        scheduledDelayMs: eligible - start,
        readyWaitMs: end - eligible,
    };
}

export function beginJobAttemptTrace(job: JobTraceContext & { id: string; attempts: number } & Partial<QueueTiming>) {
    let parent = jobParentContext(job);
    const waiting = queueWaitTiming(job);
    if (waiting) {
        const queued = trace.getTracer("evalflow.jobs").startSpan("job.queue_wait", {
            kind: SpanKind.INTERNAL,
            startTime: waiting.start,
            attributes: {
                "job.id": job.id,
                "job.attempt": job.attempts,
                "job.queue_wait_ms": waiting.totalMs,
                "job.scheduled_delay_ms": waiting.scheduledDelayMs,
                "job.ready_wait_ms": waiting.readyWaitMs,
            },
        }, parent);
        queued.setStatus({ code: SpanStatusCode.OK });
        queued.end(waiting.end);
        // Continue after the ended wait span, including when an untraced job needs a fresh root trace.
        parent = trace.setSpan(parent, queued);
    }
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
