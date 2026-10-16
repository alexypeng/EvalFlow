import "dotenv/config";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { BatchSpanProcessor, AlwaysOnSampler, ParentBasedSampler } from "@opentelemetry/sdk-trace";
import { FastifyOtelInstrumentation } from "@fastify/otel";
import type { FastifyInstance } from "fastify";

let sdk: NodeSDK | undefined;
let fastifyInstrumentation: FastifyOtelInstrumentation | undefined;
let shutdown: Promise<void> | undefined;

export function telemetrySettings(env: NodeJS.ProcessEnv, serviceName: string) {
    const disabled = env.OTEL_SDK_DISABLED;
    if (disabled !== undefined && disabled !== "true" && disabled !== "false") {
        throw new Error("OTEL_SDK_DISABLED must be true or false");
    }
    const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    if (disabled === "true" || !endpoint) return null;
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT must be an HTTP(S) URL without credentials, query or fragment");
    }
    return { endpoint: url.href, serviceName: env.OTEL_SERVICE_NAME || serviceName };
}

export function ignoreTelemetryPath(url: string | undefined) {
    const path = url?.split("?", 1)[0];
    return path === "/metrics" || path === "/health";
}

// Entrypoints call this before dynamically importing any application modules.
export function startTelemetry(serviceName: string) {
    const settings = telemetrySettings(process.env, serviceName);
    if (!settings || sdk) return;
    fastifyInstrumentation = new FastifyOtelInstrumentation({
        instrumentHooks: false,
        ignorePaths: (request) => ignoreTelemetryPath(request.url),
    });
    sdk = new NodeSDK({
        autoDetectResources: false,
        serviceName: settings.serviceName,
        sampler: new ParentBasedSampler({ root: new AlwaysOnSampler() }),
        spanProcessors: [new BatchSpanProcessor({
            exporter: new OTLPTraceExporter({ url: settings.endpoint, timeoutMillis: 1000 }),
            scheduledDelayMillis: 1000,
            exportTimeoutMillis: 1500,
        })],
        metricReaders: [],
        logRecordProcessors: [],
        instrumentations: [
            new HttpInstrumentation({
                ignoreIncomingRequestHook: (request) => ignoreTelemetryPath(request.url),
                requireParentforOutgoingSpans: true,
            }),
            fastifyInstrumentation,
            new PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false }),
        ],
    });
    sdk.start();
    console.log(`Tracing enabled for ${settings.serviceName}`);
}

export async function installApiTelemetry(app: FastifyInstance) {
    if (fastifyInstrumentation) await app.register(fastifyInstrumentation.plugin());
}

export function shutdownTelemetry(): Promise<void> {
    if (!sdk) return Promise.resolve();
    if (shutdown) return shutdown;
    const current = sdk;
    shutdown = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                current.shutdown(),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error("Trace shutdown exceeded 2000ms")), 2000);
                }),
            ]);
        } catch (error) {
            console.error("Trace export shutdown failed; remaining spans may be lost", error);
        } finally {
            clearTimeout(timer);
        }
    })();
    return shutdown;
}
