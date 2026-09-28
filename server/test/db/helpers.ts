import { prisma } from "../../src/db.js";

// Wipe all rows between tests. traces/evals cascade from jobs.
export async function resetDatabase() {
    await prisma.$executeRawUnsafe(
        "TRUNCATE TABLE jobs, runs, dataset_cases, datasets CASCADE",
    );
}
