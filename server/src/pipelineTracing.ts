import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Attributes, Span } from "@opentelemetry/api";
import { LeaseLostError } from "./heartbeat.js";

export type PipelineStep =
    | "tool.get_user_events"
    | "tool.get_feature_usage"
    | "tool.get_subscription_history"
    | "tool.get_retention_summary"
    | "prompt.build"
    | "provider.permit_wait"
    | "llm.call"
    | "output.parse"
    | "output.validate"
    | "evaluation.score";

export function tracePipelineStep<T>(
    name: PipelineStep,
    attributes: Attributes,
    operation: (span: Span) => T | Promise<T>,
): Promise<T> {
    return trace.getTracer("evalflow.pipeline").startActiveSpan(name, {
        kind: name === "llm.call" ? SpanKind.CLIENT : SpanKind.INTERNAL,
        attributes,
    }, async (span) => {
        try {
            const result = await operation(span);
            span.setAttribute("step.outcome", "success");
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
        } catch (error) {
            const outcome = error instanceof LeaseLostError ? "lease_lost" :
                error instanceof Error && error.name === "AbortError" ? "cancelled" : "error";
            span.setAttribute("step.outcome", outcome);
            span.setAttribute("error.type", error instanceof Error ? error.name : "UnknownError");
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
        } finally {
            span.end();
        }
    });
}
