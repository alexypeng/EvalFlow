import "dotenv/config";
import { defineConfig } from "vitest/config";

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5433/evalflow_test";

// Tests truncate tables, so refuse anything that doesn't look like a test DB.
const dbName = new URL(testDatabaseUrl).pathname.slice(1);
if (!dbName.endsWith("_test")) {
    throw new Error(`TEST_DATABASE_URL must point at a database ending in "_test" (got "${dbName}")`);
}

// Tests must not pick up a real LLM from a developer's .env: results would
// depend on the machine, and runs would record "gemini" instead of "mock".
const testLlmEnv = { LLM_PROVIDER: "mock", GEMINI_API_KEY: "" };

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: "unit",
                    include: ["test/unit/**/*.test.ts"],
                    env: testLlmEnv,
                },
            },
            {
                test: {
                    name: "db",
                    include: ["test/db/**/*.test.ts"],
                    // db.ts reads DATABASE_URL at import time, so point it at the test DB.
                    env: { ...testLlmEnv, DATABASE_URL: testDatabaseUrl },
                    globalSetup: ["test/db/globalSetup.ts"],
                    setupFiles: ["test/db/setup.ts"],
                    // Files share one database; run them one at a time.
                    fileParallelism: false,
                },
            },
        ],
    },
});
