import Fastify from "fastify";
import { Counter, Histogram, Registry } from "@prometheus-io/client";

export const attemptOutcomes = ["completed", "retried", "dead_letter", "lease_lost", "unconfirmed"] as const;
export type AttemptOutcome = typeof attemptOutcomes[number];

export function workerMetricsPort(env: NodeJS.ProcessEnv) {
    const port = Number(env.WORKER_METRICS_PORT ?? 9100);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("WORKER_METRICS_PORT must be an integer between 0 and 65535");
    }
    return port;
}

export function createWorkerMetrics(now: () => number = () => performance.now()) {
    const registry = new Registry();
    const attempts = new Counter({
        name: "evalflow_worker_attempts_total",
        help: "Observed ended claims by outcome; accepted transitions, discarded leases or unconfirmed finalization.",
        labelNames: ["outcome"] as const,
        registers: [registry],
    });
    const duration = new Histogram({
        name: "evalflow_worker_attempt_duration_seconds",
        help: "Elapsed seconds from claim return until observed attempt outcome, excluding queued time.",
        labelNames: ["outcome"] as const,
        buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300],
        registers: [registry],
    });
    for (const outcome of attemptOutcomes) {
        attempts.inc({ outcome }, 0);
        duration.zero({ outcome });
    }
    const app = Fastify({ forceCloseConnections: true });
    app.get("/metrics", async (_request, reply) => reply.type(registry.contentType).send(await registry.metrics()));

    return {
        app,
        beginAttempt() {
            const startedAt = now();
            let finished = false;
            let settlement: Promise<unknown> = Promise.resolve();
            const finish = (outcome: AttemptOutcome) => {
                // Pipeline finalization and shutdown cleanup can both observe the same claim ending.
                if (finished) return;
                finished = true;
                attempts.inc({ outcome });
                duration.observe({ outcome }, Math.max(0, now() - startedAt) / 1000);
            };
            return {
                finish,
                finalize<T>(operation: () => Promise<T>): Promise<T> {
                    // Observe a completed write before a racing shutdown release can observe an absent lease.
                    const pending = settlement.then(operation);
                    settlement = pending.catch(() => undefined);
                    return pending;
                },
            };
        },
    };
}
