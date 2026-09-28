import { execSync } from "node:child_process";

export default function setup() {
    execSync("prisma migrate deploy", {
        stdio: "inherit",
        env: {
            ...process.env,
            DATABASE_URL:
                process.env.TEST_DATABASE_URL ??
                "postgresql://postgres:postgres@localhost:5433/evalflow_test",
        },
    });
}
