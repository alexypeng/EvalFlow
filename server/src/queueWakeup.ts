import { Client } from "pg";
import { z } from "zod";

export const jobNotificationChannel = "evalflow_jobs";

export function workerWakeupSettings(env: NodeJS.ProcessEnv) {
    const mode = z.enum(["poll", "notify"]).default("poll").parse(env.WORKER_WAKEUP_MODE);
    const pollIntervalMs = z.coerce.number().int().min(1).max(2_147_483_647).default(2000)
        .parse(env.POLL_INTERVAL_MS);
    // Notification mode preserves the agreed one-second delayed-retry/missed-event check.
    return { mode, idleIntervalMs: mode === "notify" ? 1000 : pollIntervalMs };
}

export function createIdleWakeup(intervalMs: number, signal: AbortSignal) {
    let generation = 0;
    const waiters = new Set<() => void>();
    return {
        version: () => generation,
        wake() {
            generation++;
            for (const done of [...waiters]) done();
        },
        wait(version: number) {
            // Capture version BEFORE claiming, so a notification arriving during that query
            // cannot disappear in the gap between an empty result and registering a waiter.
            if (signal.aborted || version !== generation) return Promise.resolve();
            return new Promise<void>((resolve) => {
                const done = () => {
                    clearTimeout(timer);
                    signal.removeEventListener("abort", done);
                    waiters.delete(done);
                    resolve();
                };
                const timer = setTimeout(done, intervalMs);
                waiters.add(done);
                signal.addEventListener("abort", done, { once: true });
            });
        },
    };
}

// One dedicated connection per process, separate from the Prisma query pool.
// Keep it outside transactions so LISTEN commits and notifications arrive promptly.
export function startQueueListener(options: {
    connectionString: string | undefined;
    signal: AbortSignal;
    wake: () => void;
    onState?: (state: "listening" | "disconnected") => void;
    createClient?: () => Client;
}) {
    const { signal } = options;
    const createClient = options.createClient ?? (() => new Client({
        connectionString: options.connectionString,
        application_name: "evalflow-worker-listener",
        connectionTimeoutMillis: 1000,
        query_timeout: 1000,
        statement_timeout: 1000,
        keepAlive: true,
    }));
    const closed = (async () => {
        while (!signal.aborted) {
            const client = createClient();
            let disconnected = false;
            let finish!: () => void;
            const lost = new Promise<void>((resolve) => { finish = resolve; });
            let ending: Promise<void> | undefined;
            const end = () => ending ??= client.end().catch(() => {});
            const disconnect = () => { disconnected = true; finish(); };
            const stop = () => { disconnect(); void end(); };
            client.on("error", disconnect);
            client.on("end", disconnect);
            client.on("notification", (message) => {
                if (!signal.aborted && !disconnected && message.channel === jobNotificationChannel) options.wake();
            });
            signal.addEventListener("abort", stop, { once: true });
            try {
                await client.connect();
                if (!signal.aborted && !disconnected) {
                    await client.query(`LISTEN ${jobNotificationChannel}`);
                    if (!signal.aborted && !disconnected) {
                        // LISTEN first, then inspect saved jobs, including work missed on reconnect.
                        options.wake();
                        options.onState?.("listening");
                        await lost;
                    }
                }
            } catch {
                // Backup claims continue during listener outages. Do not log connection credentials.
            } finally {
                signal.removeEventListener("abort", stop);
                await end();
            }
            if (!signal.aborted) {
                options.onState?.("disconnected");
                await createIdleWakeup(1000, signal).wait(0);
            }
        }
    })();
    return { closed };
}
