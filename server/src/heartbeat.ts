import { setTimeout as sleep } from "node:timers/promises";

export class LeaseLostError extends Error {
    constructor() {
        super("Job lease lost; abandoning this attempt");
        this.name = "LeaseLostError";
    }
}

// Renew serially, so a slow database cannot accumulate overlapping heartbeat queries.
export function startHeartbeat(intervalMs: number, renew: () => Promise<boolean>) {
    const controller = new AbortController();
    let lost = false;
    const done = (async () => {
        while (!controller.signal.aborted) {
            try {
                await sleep(intervalMs, undefined, { signal: controller.signal });
            } catch (error) {
                if (controller.signal.aborted) return;
                throw error;
            }
            try {
                if (!(await renew())) {
                    lost = true;
                    return;
                }
            } catch {
                // Ownership is uncertain after a database error. Final writes still check the DB lease.
                lost = true;
                return;
            }
        }
    })();
    return {
        assertActive() {
            if (lost) throw new LeaseLostError();
        },
        async stop() {
            controller.abort();
            await done;
        },
    };
}
