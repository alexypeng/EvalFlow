import { Prisma } from "./generated/prisma/client.js";
import { prisma } from "./db.js";

export async function createJob(
    type: string,
    input: Prisma.InputJsonValue,
    maxAttempts = 3,
) {
    return prisma.job.create({
        data: {
            type,
            input,
            maxAttempts,
            status: "queued",
        },
    });
}

export async function listJobs() {
    return prisma.job.findMany({
        orderBy: {
            createdAt: "desc",
        },
        take: 100,
    });
}

export async function getJobById(id: string) {
    return prisma.job.findUnique({
        where: {
            id,
        },
    });
}
