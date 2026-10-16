import { trace } from "@opentelemetry/api";
import { shutdownTelemetry, startTelemetry } from "../../src/telemetry.js";

startTelemetry("evalflow-shutdown-test");
trace.getTracer("test").startSpan("shutdown-flush-test").end();
const first = shutdownTelemetry();
if (first !== shutdownTelemetry()) throw new Error("Shutdown must be idempotent");
await first;
console.log("Telemetry shutdown complete");
