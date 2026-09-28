import { prisma } from "../../src/db.js";

// traces and evals cascade from jobs.
export async function resetDatabase() {
    await prisma.$executeRawUnsafe(
        "TRUNCATE TABLE jobs, runs, dataset_cases, datasets CASCADE",
    );
}
