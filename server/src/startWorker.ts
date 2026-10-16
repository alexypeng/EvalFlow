import { shutdownTelemetry, startTelemetry } from "./telemetry.js";

startTelemetry("evalflow-worker");
try {
    await import("./worker.js");
} finally {
    await shutdownTelemetry();
}
