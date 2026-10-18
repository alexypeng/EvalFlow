import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

export function installHealthChecks(app: FastifyInstance, options: {
    isStopping?: () => boolean;
    checkDatabase?: () => Promise<unknown>;
} = {}) {
    const isStopping = options.isStopping ?? (() => false);
    let checkDatabase = options.checkDatabase;
    if (!checkDatabase) {
        // Isolate probe deadlines from application queries and keep probe connections bounded.
        const pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            max: 1,
            connectionTimeoutMillis: 1000,
            query_timeout: 1000,
            statement_timeout: 1000,
        });
        // An idle connection can fail between probes; pg removes that client automatically.
        pool.on("error", () => app.log.warn("Readiness database connection lost"));
        app.addHook("onClose", async () => { await pool.end(); });
        checkDatabase = () => pool.query("SELECT 1");
    }
    const probe = checkDatabase;
    app.get("/livez", async () => ({ ok: true }));
    app.get("/readyz", async (_request, reply) => {
        if (isStopping()) return reply.code(503).send({ ok: false });
        try {
            await probe();
            if (!isStopping()) return { ok: true };
        } catch {
            // Connection details and credentials do not belong in public probe responses.
        }
        return reply.code(503).send({ ok: false });
    });
}
