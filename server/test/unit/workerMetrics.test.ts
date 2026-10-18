import { afterEach, describe, expect, it } from "vitest";
import { attemptOutcomes, createWorkerMetrics, workerMetricsPort } from "../../src/workerMetrics.js";
import { LeaseLostError } from "../../src/heartbeat.js";

const instances: ReturnType<typeof createWorkerMetrics>[] = [];
function create(now?: () => number) {
    const metrics = createWorkerMetrics(now);
    instances.push(metrics);
    return metrics;
}
afterEach(async () => { await Promise.all(instances.splice(0).map(({ app }) => app.close())); });

describe("worker metrics", () => {
    it("counts claim results without changing returned ownership or rejected errors", async () => {
        const metrics = create();
        const job = { id: "job", leaseToken: "token" };
        const error = new Error("database unavailable");
        expect(await metrics.measureClaim(async () => job)).toBe(job);
        expect(await metrics.measureClaim(async () => null)).toBeNull();
        await expect(metrics.measureClaim(async () => { throw error; })).rejects.toBe(error);
        const { body } = await metrics.app.inject("/metrics");
        for (const outcome of ["claimed", "empty", "error"]) {
            expect(body).toContain(`evalflow_worker_claim_queries_total{outcome="${outcome}"} 1`);
        }
        expect(body).toContain('evalflow_worker_attempts_total{outcome="completed"} 0');
    });

    it.each(["measureLlm", "measurePermitWait"] as const)(
        "%s records successful operation time without including later trace work", async (method) => {
            let now = 1000;
            const metrics = create(() => now);
            const result = { text: "result" };
            expect(await metrics[method]("mock", async () => { now = 1500; return result; })).toBe(result);
            now = 15000;
            const { body } = await metrics.app.inject("/metrics");
            const name = method === "measureLlm" ? "evalflow_llm_call_duration_seconds" :
                "evalflow_provider_rate_limit_wait_duration_seconds";
            expect(body).toContain(`${name}_sum{provider="mock",outcome="success"} 0.5`);
            expect(body).toContain(`${name}_count{provider="mock",outcome="success"} 1`);
            expect(body).toContain(`${name}_count{provider="gemini",outcome="success"} 0`);
        },
    );

    it.each(["measureLlm", "measurePermitWait"] as const)(
        "%s records failures and interruptions, preserving the original rejection", async (method) => {
            let now = 0;
            const metrics = create(() => now);
            for (const [error, outcome] of [
                [new Error("provider unavailable"), "error"],
                [new DOMException("shutdown", "AbortError"), "cancelled"],
                [new LeaseLostError(), "lease_lost"],
            ] as const) {
                await expect(metrics[method]("gemini", async () => { now += 250; throw error; })).rejects.toBe(error);
                const name = method === "measureLlm" ? "evalflow_llm_call_duration_seconds" :
                    "evalflow_provider_rate_limit_wait_duration_seconds";
                const { body } = await metrics.app.inject("/metrics");
                expect(body).toContain(`${name}_sum{provider="gemini",outcome="${outcome}"} 0.25`);
                expect(body).toContain(`${name}_count{provider="gemini",outcome="${outcome}"} 1`);
            }
        },
    );

    it("exposes zeros for idle workers without counting scrapes as attempts", async () => {
        const { app } = create();
        const first = await app.inject("/metrics");
        expect(first.headers["content-type"]).toContain("text/plain; version=0.0.4");
        for (const outcome of attemptOutcomes) {
            expect(first.body).toContain(`evalflow_worker_attempts_total{outcome="${outcome}"} 0`);
            expect(first.body).toContain(`evalflow_worker_attempt_duration_seconds_count{outcome="${outcome}"} 0`);
        }
        expect((await app.inject("/metrics")).body).toBe(first.body);
        expect((await app.inject("/jobs")).statusCode).toBe(404);
    });

    it("records one duration and outcome despite racing or repeated finish calls", async () => {
        let now = 1000;
        const metrics = create(() => now);
        const { finish } = metrics.beginAttempt();
        now = 3500;
        finish("completed");
        finish("lease_lost");
        finish("unconfirmed");
        const { body } = await metrics.app.inject("/metrics");
        expect(body).toContain('evalflow_worker_attempts_total{outcome="completed"} 1');
        expect(body).toContain('evalflow_worker_attempts_total{outcome="lease_lost"} 0');
        expect(body).toContain('evalflow_worker_attempt_duration_seconds_sum{outcome="completed"} 2.5');
        expect(body).toContain('evalflow_worker_attempt_duration_seconds_count{outcome="completed"} 1');
    });

    it("keeps concurrent claims independent and distinguishes retries from final failures", async () => {
        let now = 0;
        const metrics = create(() => now);
        const retry = metrics.beginAttempt().finish;
        now = 500;
        const terminal = metrics.beginAttempt().finish;
        const discarded = metrics.beginAttempt().finish;
        const uncertain = metrics.beginAttempt().finish;
        now = 1000;
        retry("retried");
        terminal("dead_letter");
        discarded("lease_lost");
        uncertain("unconfirmed");
        const { body } = await metrics.app.inject("/metrics");
        for (const outcome of ["retried", "dead_letter", "lease_lost", "unconfirmed"]) {
            expect(body).toContain(`evalflow_worker_attempts_total{outcome="${outcome}"} 1`);
        }
        expect(body).toContain('evalflow_worker_attempt_duration_seconds_sum{outcome="retried"} 1');
        expect(body).toContain('evalflow_worker_attempt_duration_seconds_sum{outcome="dead_letter"} 0.5');
    });

    it("starts a fresh registry for a new worker process", async () => {
        const first = create();
        first.beginAttempt().finish("completed");
        const next = create();
        expect((await next.app.inject("/metrics")).body)
            .toContain('evalflow_worker_attempts_total{outcome="completed"} 0');
    });

    it("validates listener ports, including port zero for isolated subprocess tests", () => {
        expect(workerMetricsPort({})).toBe(9100);
        expect(workerMetricsPort({ WORKER_METRICS_PORT: "0" })).toBe(0);
        for (const value of ["-1", "65536", "1.5", "bad"]) {
            expect(() => workerMetricsPort({ WORKER_METRICS_PORT: value })).toThrow("WORKER_METRICS_PORT");
        }
    });

    it("observes in-flight completion before a racing shutdown release", async () => {
        const metrics = create();
        const attempt = metrics.beginAttempt();
        let release!: () => void;
        const pendingWrite = new Promise<void>((resolve) => { release = resolve; });
        const completion = attempt.finalize(async () => {
            await pendingWrite;
            attempt.finish("completed");
        });
        const cleanup = attempt.finalize(async () => attempt.finish("lease_lost"));
        release();
        await Promise.all([completion, cleanup]);
        const { body } = await metrics.app.inject("/metrics");
        expect(body).toContain('evalflow_worker_attempts_total{outcome="completed"} 1');
        expect(body).toContain('evalflow_worker_attempts_total{outcome="lease_lost"} 0');
    });

    it("allows failure cleanup after a rejected completion write", async () => {
        const metrics = create();
        const attempt = metrics.beginAttempt();
        await expect(attempt.finalize(async () => { throw new Error("completion rolled back"); }))
            .rejects.toThrow("completion rolled back");
        await attempt.finalize(async () => attempt.finish("retried"));
        expect((await metrics.app.inject("/metrics")).body)
            .toContain('evalflow_worker_attempts_total{outcome="retried"} 1');
    });
});
