export function reaperHealthPort(env: NodeJS.ProcessEnv) {
    const port = Number(env.REAPER_HEALTH_PORT ?? 9101);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("REAPER_HEALTH_PORT must be an integer between 0 and 65535");
    }
    return port;
}

export function reaperSettings(env: NodeJS.ProcessEnv) {
    const intervalMs = Number(env.REAPER_INTERVAL_MS ?? 5000);
    const batchSize = Number(env.REAPER_BATCH_SIZE ?? 100);
    if (!Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 2_147_483_647) {
        throw new Error("REAPER_INTERVAL_MS must be an integer between 1 and 2147483647");
    }
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
        throw new Error("REAPER_BATCH_SIZE must be an integer between 1 and 1000");
    }
    return { intervalMs, batchSize };
}
