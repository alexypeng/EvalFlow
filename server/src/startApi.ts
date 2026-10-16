import { shutdownTelemetry, startTelemetry } from "./telemetry.js";

startTelemetry("evalflow-api");
try {
    await import("./api.js");
} catch (error) {
    await shutdownTelemetry();
    throw error;
}
