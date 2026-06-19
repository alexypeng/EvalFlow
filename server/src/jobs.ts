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

export async function claimNextJob() {
    const jobs = await prisma.$queryRaw<
        Array<{
            id: string;
            type: string;
            status: string;
            input: unknown;
            result: unknown | null;
            error: string | null;
            attempts: number;
            maxAttempts: number;
            createdAt: Date;
            startedAt: Date | null;
            completedAt: Date | null;
            latencyMs: number | null;
            promptTokens: number | null;
            completionTokens: number | null;
            totalTokens: number | null;
            estimatedCost: unknown | null;
            evalScore: number | null;
        }>
    >`
          UPDATE jobs
          SET
              status = 'running',
              attempts = attempts + 1,
              started_at = now(),
              completed_at = NULL,
              error = NULL
          WHERE id = (
              SELECT id
              FROM jobs
              WHERE status = 'queued'
              ORDER BY created_at ASC
              FOR UPDATE SKIP LOCKED
              LIMIT 1
          )
          RETURNING
              id,
              type,
              status,
              input,
              result,
              error,
              attempts,
              max_attempts AS "maxAttempts",
              created_at AS "createdAt",
              started_at AS "startedAt",
              completed_at AS "completedAt",
              latency_ms AS "latencyMs",
              prompt_tokens AS "promptTokens",
              completion_tokens AS "completionTokens",
              total_tokens AS "totalTokens",
              estimated_cost AS "estimatedCost",
              eval_score AS "evalScore"
      `;

    return jobs[0] ?? null;
}

export async function completeJob(
    id: string,
    result: Prisma.InputJsonValue,
    latencyMs: number,
) {
    return prisma.job.update({
        where: {
            id,
        },
        data: {
            status: "completed",
            result,
            completedAt: new Date(),
            latencyMs,
            promptTokens: 120,
            completionTokens: 80,
            totalTokens: 200,
            estimatedCost: 0,
            evalScore: 100,
        },
    });
}
