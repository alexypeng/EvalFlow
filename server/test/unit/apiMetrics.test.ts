import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installApiMetrics } from "../../src/apiMetrics.js";
import type { JobCounts } from "../../src/jobs.js";

const apps: FastifyInstance[] = [];

const emptyCounts: JobCounts = { queued: 0, running: 0, completed: 0, dead_letter: 0 };

function createApp(readJobCounts: () => Promise<JobCounts> = async () => emptyCounts) {
    const app = Fastify();
    installApiMetrics(app, readJobCounts);
    apps.push(app);
    return app;
}

afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("API Prometheus measurements", () => {
    it("excludes Kubernetes probes from application traffic", async () => {
        const app = createApp();
        app.get("/livez", async () => ({ ok: true }));
        app.get("/readyz", async () => ({ ok: true }));
        await app.inject("/livez");
        await app.inject("/readyz");
        const { body } = await app.inject("/metrics");
        expect(body).not.toContain('route="/livez"');
        expect(body).not.toContain('route="/readyz"');
    });
    it("reads job counts only when scraped and replaces every status, including zeros", async () => {
        const readCounts = vi.fn()
            .mockResolvedValueOnce({ queued: 8, running: 2, completed: 5, dead_letter: 1 })
            .mockResolvedValueOnce({ queued: 0, running: 0, completed: 15, dead_letter: 1 });
        const app = createApp(readCounts);
        app.get("/example", async () => "ok");
        await app.inject("/example");
        expect(readCounts).not.toHaveBeenCalled();

        const first = await app.inject("/metrics");
        expect(first.body).toContain("# TYPE evalflow_jobs gauge");
        expect(first.body).toContain('evalflow_jobs{status="queued"} 8');
        expect(first.body).toContain('evalflow_jobs{status="running"} 2');
        expect(first.body).toContain('evalflow_jobs{status="completed"} 5');
        expect(first.body).toContain('evalflow_jobs{status="dead_letter"} 1');
        const next = await app.inject("/metrics");
        expect(next.body).toContain('evalflow_jobs{status="queued"} 0');
        expect(next.body).toContain('evalflow_jobs{status="running"} 0');
        expect(next.body).toContain('evalflow_jobs{status="completed"} 15');
        expect(readCounts).toHaveBeenCalledTimes(2);
    });

    it("fails a DB-error scrape instead of returning old counts, and recovers on the next scrape", async () => {
        const readCounts = vi.fn()
            .mockResolvedValueOnce({ ...emptyCounts, queued: 8 })
            .mockRejectedValueOnce(new Error("database unavailable"))
            .mockResolvedValueOnce(emptyCounts);
        const app = createApp(readCounts);
        expect((await app.inject("/metrics")).statusCode).toBe(200);
        const failed = await app.inject("/metrics");
        expect(failed.statusCode).toBe(500);
        expect(failed.body).not.toContain("evalflow_jobs");
        const recovered = await app.inject("/metrics");
        expect(recovered.statusCode).toBe(200);
        expect(recovered.body).toContain('evalflow_jobs{status="queued"} 0');
    });

    it("exposes Prometheus text without counting scrape traffic", async () => {
        const app = createApp();
        app.get("/stats", async () => ({ totalJobs: 3 }));
        const stats = await app.inject("/stats");
        expect(stats.json()).toEqual({ totalJobs: 3 });

        const first = await app.inject("/metrics");
        expect(first.statusCode).toBe(200);
        expect(first.headers["content-type"]).toContain("text/plain; version=0.0.4");
        expect(first.body).toContain("# TYPE evalflow_http_requests_total counter");
        expect(first.body).toContain("# TYPE evalflow_http_request_duration_seconds histogram");
        expect(first.body).toContain('evalflow_http_requests_total{method="GET",route="/stats",status_code="200"} 1');
        await app.inject({ method: "HEAD", url: "/metrics" });
        const second = await app.inject("/metrics");
        expect(second.body).toBe(first.body);
    });

    it("groups IDs and query strings under the registered route pattern", async () => {
        const app = createApp();
        app.get("/jobs/:id", async () => ({ ok: true }));
        await app.inject("/jobs/first-private-id?user=alice");
        await app.inject("/jobs/second-private-id?user=bob");

        const { body } = await app.inject("/metrics");
        expect(body).toContain('evalflow_http_requests_total{method="GET",route="/jobs/:id",status_code="200"} 2');
        expect(body).not.toMatch(/first-private-id|second-private-id|alice|bob/);
        expect(body).toContain(
            'evalflow_http_request_duration_seconds_count{method="GET",route="/jobs/:id",status_code="200"} 2',
        );
    });

    it("groups arbitrary unknown URLs under one unmatched label", async () => {
        const app = createApp();
        await app.inject("/unknown/one?secret=alice");
        await app.inject("/unknown/two?secret=bob");

        const { body } = await app.inject("/metrics");
        expect(body).toContain('evalflow_http_requests_total{method="GET",route="unmatched",status_code="404"} 2');
        expect(body).not.toMatch(/unknown\/|alice|bob/);
    });

    it("records validation failures and thrown errors with their final status and method", async () => {
        const app = createApp();
        app.post("/jobs", { schema: { body: { type: "object", required: ["input"] } } }, async () => ({ ok: true }));
        app.get("/broken", async () => {
            throw new Error("database unavailable");
        });
        expect((await app.inject({ method: "POST", url: "/jobs", payload: {} })).statusCode).toBe(400);
        expect((await app.inject("/broken")).statusCode).toBe(500);

        const { body } = await app.inject("/metrics");
        expect(body).toContain('evalflow_http_requests_total{method="POST",route="/jobs",status_code="400"} 1');
        expect(body).toContain('evalflow_http_requests_total{method="GET",route="/broken",status_code="500"} 1');
    });

    it("records elapsed time in seconds with cumulative duration buckets", async () => {
        const app = createApp();
        app.get("/slow", async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return { ok: true };
        });
        await app.inject("/slow");

        const { body } = await app.inject("/metrics");
        const sum = body.match(/evalflow_http_request_duration_seconds_sum\{[^\n]*\} ([\d.e+-]+)/);
        expect(sum).not.toBeNull();
        expect(Number(sum![1])).toBeGreaterThanOrEqual(0.02);
        expect(Number(sum![1])).toBeLessThan(5);
        expect(body).toContain('le="0.005",method="GET",route="/slow",status_code="200"} 0');
        expect(body).toContain('le="+Inf",method="GET",route="/slow",status_code="200"} 1');
    });

    it("keeps registries isolated across API instances and restarts", async () => {
        const first = createApp();
        const second = createApp();
        first.get("/example", async () => "ok");
        await first.inject("/example");

        expect((await first.inject("/metrics")).body).toContain('route="/example"');
        expect((await second.inject("/metrics")).body).not.toContain('route="/example"');
    });
});
