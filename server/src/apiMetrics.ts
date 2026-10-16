import type { FastifyInstance } from "fastify";
import { Counter, Gauge, Histogram, Registry } from "@prometheus-io/client";
import type { JobCounts } from "./jobs.js";

const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]);

export function installApiMetrics(app: FastifyInstance, readJobCounts: () => Promise<JobCounts>): void {
    // A registry belongs to one API instance; workers and tests must not share its counters.
    const registry = new Registry();
    new Gauge({
        name: "evalflow_jobs",
        help: "Current jobs stored in Postgres by status; queued includes delayed retries.",
        labelNames: ["status"] as const,
        registers: [registry],
        async collect() {
            // Read the full snapshot before setting values; DB errors fail the scrape instead of publishing stale counts.
            const counts = await readJobCounts();
            for (const status of ["queued", "running", "completed", "dead_letter"] as const) {
                this.set({ status }, counts[status]);
            }
        },
    });
    const labelNames = ["method", "route", "status_code"] as const;
    const requests = new Counter({
        name: "evalflow_http_requests_total",
        help: "Number of completed API responses, excluding metrics scrapes.",
        labelNames,
        registers: [registry],
    });
    const duration = new Histogram({
        name: "evalflow_http_request_duration_seconds",
        help: "API response duration in seconds, excluding metrics scrapes.",
        labelNames,
        buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
        registers: [registry],
    });

    app.addHook("onResponse", async (request, reply) => {
        const route = request.routeOptions.url ?? "unmatched";
        if (route === "/metrics") return;

        const labels = {
            method: methods.has(request.method) ? request.method : "OTHER",
            route,
            status_code: String(reply.statusCode),
        };
        requests.inc(labels);
        duration.observe(labels, reply.elapsedTime / 1000);
    });

    app.get("/metrics", async (_request, reply) => {
        return reply.type(registry.contentType).send(await registry.metrics());
    });
}
