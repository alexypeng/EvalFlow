import Fastify from "fastify";
import { Counter, Histogram, Registry } from "@prometheus-io/client";
import { LeaseLostError } from "./heartbeat.js";
import type { LlmProvider } from "./llm.js";

export const attemptOutcomes = ["completed", "retried", "dead_letter", "lease_lost", "unconfirmed"] as const;
export type AttemptOutcome = typeof attemptOutcomes[number];
const stepOutcomes = ["success", "error", "cancelled", "lease_lost"] as const;
const durationBuckets = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300];

export function workerMetricsPort(env: NodeJS.ProcessEnv) {
    const port = Number(env.WORKER_METRICS_PORT ?? 9100);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("WORKER_METRICS_PORT must be an integer between 0 and 65535");
    }
    return port;
}

export function createWorkerMetrics(now: () => number = () => performance.now()) {
    const registry = new Registry();
    const claimQueries = new Counter({
        name: "evalflow_worker_claim_queries_total",
        help: "Observed queue claim operations by result; errors may occur before or after a query reaches Postgres.",
        labelNames: ["outcome"] as const,
        registers: [registry],
    });
    for (const outcome of ["claimed", "empty", "error"]) claimQueries.inc({ outcome }, 0);
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
        buckets: durationBuckets,
        registers: [registry],
    });
    const llmDuration = new Histogram({
        name: "evalflow_llm_call_duration_seconds",
        help: "Elapsed seconds in the LLM call wrapper, including rejected calls and excluding trace writes.",
        labelNames: ["provider", "outcome"] as const,
        buckets: durationBuckets,
        registers: [registry],
    });
    const permitDuration = new Histogram({
        name: "evalflow_provider_rate_limit_wait_duration_seconds",
        help: "Elapsed seconds acquiring a provider permit, including interrupted waits and excluding trace writes.",
        labelNames: ["provider", "outcome"] as const,
        buckets: durationBuckets,
        registers: [registry],
    });
    for (const provider of ["mock", "gemini"] as const) {
        for (const outcome of stepOutcomes) {
            llmDuration.zero({ provider, outcome });
            permitDuration.zero({ provider, outcome });
        }
    }
    async function measure<T>(
        histogram: Histogram<"provider" | "outcome">,
        provider: LlmProvider,
        operation: () => Promise<T>,
    ): Promise<T> {
        const startedAt = now();
        let outcome: typeof stepOutcomes[number] = "success";
        try {
            return await operation();
        } catch (error) {
            outcome = error instanceof LeaseLostError ? "lease_lost" :
                error instanceof Error && error.name === "AbortError" ? "cancelled" : "error";
            throw error;
        } finally {
            histogram.observe({ provider, outcome }, Math.max(0, now() - startedAt) / 1000);
        }
    }
    for (const outcome of attemptOutcomes) {
        attempts.inc({ outcome }, 0);
        duration.zero({ outcome });
    }
    const app = Fastify({ forceCloseConnections: true });
    app.get("/metrics", async (_request, reply) => reply.type(registry.contentType).send(await registry.metrics()));

    return {
        app,
        async measureClaim<T>(operation: () => Promise<T | null>): Promise<T | null> {
            try {
                const job = await operation();
                claimQueries.inc({ outcome: job === null ? "empty" : "claimed" });
                return job;
            } catch (error) {
                claimQueries.inc({ outcome: "error" });
                throw error;
            }
        },
        measureLlm<T>(provider: LlmProvider, operation: () => Promise<T>) {
            return measure(llmDuration, provider, operation);
        },
        measurePermitWait<T>(provider: LlmProvider, operation: () => Promise<T>) {
            return measure(permitDuration, provider, operation);
        },
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
