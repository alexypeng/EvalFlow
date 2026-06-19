import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { checkDatabaseConnection, migrate } from "./db.js";

const app = Fastify({
    logger: true,
});

await app.register(cors, {
    origin: true,
});

await migrate();

app.get("/health", async () => {
    const db = await checkDatabaseConnection();

    return {
        ok: true,
        dbTime: db.now,
    };
});

const port = Number(process.env.PORT ?? 3000);

await app.listen({
    port,
    host: "0.0.0.0",
});


