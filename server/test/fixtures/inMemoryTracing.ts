import { context, propagation, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";

export function startInMemoryTracing() {
    const exporter = new InMemorySpanExporter();
    const disabled = process.env.OTEL_SDK_DISABLED;
    process.env.OTEL_SDK_DISABLED = "false";
    const sdk = new NodeSDK({
        autoDetectResources: false,
        spanProcessors: [new SimpleSpanProcessor({ exporter })],
        metricReaders: [],
        logRecordProcessors: [],
    });
    try { sdk.start(); } finally {
        if (disabled === undefined) delete process.env.OTEL_SDK_DISABLED;
        else process.env.OTEL_SDK_DISABLED = disabled;
    }
    return {
        exporter,
        async close() {
            await sdk.shutdown();
            context.disable();
            propagation.disable();
            trace.disable();
        },
    };
}
