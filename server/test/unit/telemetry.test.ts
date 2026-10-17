import { expect, it } from "vitest";
import { ignoreTelemetryPath, telemetrySettings } from "../../src/telemetry.js";

it("requires an explicit trace endpoint and honors the disable switch", () => {
    expect(telemetrySettings({}, "evalflow-api")).toBeNull();
    expect(telemetrySettings({
        OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "not a url",
    }, "evalflow-api")).toBeNull();
    expect(telemetrySettings({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://localhost:4318/v1/traces",
    }, "evalflow-worker")).toEqual({
        endpoint: "http://localhost:4318/v1/traces", serviceName: "evalflow-worker",
    });
    expect(telemetrySettings({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://tempo.example/v1/traces", OTEL_SERVICE_NAME: "custom",
    }, "evalflow-api")?.serviceName).toBe("custom");
});

it.each(["ftp://tempo/traces", "http://user:secret@tempo/traces", "http://tempo/traces?key=x", "http://tempo/#x"])(
    "rejects unsupported trace endpoints: %s", (endpoint) => {
        expect(() => telemetrySettings({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint }, "api")).toThrow();
    },
);

it("rejects a misspelled disable switch", () => {
    expect(() => telemetrySettings({ OTEL_SDK_DISABLED: "yes" }, "api")).toThrow("true or false");
});

it("excludes monitoring paths with query strings without excluding application routes", () => {
    for (const path of ["/metrics", "/health", "/metrics?x=1", "/health?x=1", "/livez", "/readyz?x=1"]) {
        expect(ignoreTelemetryPath(path)).toBe(true);
    }
    for (const path of ["/stats", "/jobs", "/jobs/health", "/healthcheck", undefined]) {
        expect(ignoreTelemetryPath(path)).toBe(false);
    }
});
