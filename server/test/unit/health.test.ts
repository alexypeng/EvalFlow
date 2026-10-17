import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { installHealthChecks } from "../../src/health.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function create(checkDatabase: () => Promise<unknown>, isStopping = () => false) {
    const app = Fastify();
    installHealthChecks(app, { checkDatabase, isStopping });
    apps.push(app);
    return app;
}

it("keeps liveness independent from unavailable dependencies and shutdown readiness", async () => {
    const check = vi.fn().mockRejectedValue(new Error("unavailable"));
    const app = create(check, () => true);
    expect((await app.inject("/livez")).statusCode).toBe(200);
    expect(check).not.toHaveBeenCalled();
});

it("becomes ready, unready and ready again without disclosing database errors", async () => {
    const check = vi.fn().mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("postgresql://user:secret@host/database"))
        .mockResolvedValueOnce(undefined);
    const app = create(check);
    expect((await app.inject("/readyz")).statusCode).toBe(200);
    const failed = await app.inject("/readyz");
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ ok: false });
    expect(failed.body).not.toContain("secret");
    expect((await app.inject("/livez")).statusCode).toBe(200);
    expect((await app.inject("/readyz")).statusCode).toBe(200);
});

it("stops readiness immediately on shutdown without checking the database", async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const app = create(check, () => true);
    expect((await app.inject("/readyz")).statusCode).toBe(503);
    expect(check).not.toHaveBeenCalled();
});

it("does not report ready if shutdown begins during a database probe", async () => {
    let stopping = false;
    const app = create(async () => { stopping = true; }, () => stopping);
    expect((await app.inject("/readyz")).statusCode).toBe(503);
});
