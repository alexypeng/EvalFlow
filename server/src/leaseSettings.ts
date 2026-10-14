export function validateLeaseDuration(leaseDurationMs: number) {
    if (!Number.isInteger(leaseDurationMs) || leaseDurationMs < 1 || leaseDurationMs > 2_147_483_647) {
        throw new Error("LEASE_DURATION_MS must be an integer between 1 and 2147483647");
    }
}

export function workerLeaseSettings(env: NodeJS.ProcessEnv) {
    const leaseDurationMs = Number(env.LEASE_DURATION_MS ?? 60_000);
    const heartbeatIntervalMs = Number(env.HEARTBEAT_INTERVAL_MS ?? 20_000);
    validateLeaseDuration(leaseDurationMs);
    if (
        !Number.isInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1 || heartbeatIntervalMs >= leaseDurationMs
    ) {
        throw new Error("HEARTBEAT_INTERVAL_MS must be a positive integer smaller than LEASE_DURATION_MS");
    }
    return { leaseDurationMs, heartbeatIntervalMs };
}

