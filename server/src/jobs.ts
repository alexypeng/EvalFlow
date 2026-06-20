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

export async function getMetrics() {
    const [totalJobs, completedJobs, failedJobs, aggregates] =
        await Promise.all([
            prisma.job.count(),
            prisma.job.count({
                where: { status: "completed" },
            }),
            prisma.job.count({
                where: { status: "failed" },
            }),
            prisma.job.aggregate({
                _avg: {
                    latencyMs: true,
                    evalScore: true,
                },
                _sum: {
                    totalTokens: true,
                },
            }),
        ]);

    return {
        totalJobs,
        completedJobs,
        failedJobs,
        averageLatencyMs: aggregates._avg.latencyMs,
        averageEvalScore: aggregates._avg.evalScore,
        totalTokens: aggregates._sum.totalTokens ?? 0,
    };
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

export async function completeJob(params: {
    id: string;
    result: Prisma.InputJsonValue;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
    evalScore?: number;
}) {
    return prisma.job.update({
        where: {
            id: params.id,
        },
        data: {
            status: "completed",
            result: params.result,
            completedAt: new Date(),
            latencyMs: params.latencyMs,
            promptTokens: params.promptTokens,
            completionTokens: params.completionTokens,
            totalTokens: params.totalTokens,
            estimatedCost: params.estimatedCost,
            evalScore: params.evalScore,
        },
    });
}

export async function failOrRetryJob(params: {
    id: string;
    attempts: number;
    maxAttempts: number;
    error: string;
}) {
    const shouldRetry = params.attempts < params.maxAttempts;

    return prisma.job.update({
        where: {
            id: params.id,
        },
        data: {
            status: shouldRetry ? "queued" : "failed",
            error: params.error,
            completedAt: shouldRetry ? null : new Date(),
        },
    });
}

export async function retryJob(id: string) {
    const job = await prisma.job.findUnique({
        where: { id },
    });

    if (!job) {
        return {
            ok: false as const,
            reason: "not_found" as const,
        };
    }

    if (job.status !== "failed") {
        return {
            ok: false as const,
            reason: "not_failed" as const,
            job,
        };
    }

    const retriedJob = await prisma.job.update({
        where: { id },
        data: {
            status: "queued",
            attempts: 0,
            error: null,
            result: Prisma.DbNull,
            startedAt: null,
            completedAt: null,
            latencyMs: null,
            promptTokens: null,
            completionTokens: null,
            totalTokens: null,
            estimatedCost: null,
            evalScore: null,
        },
    });

    return {
        ok: true as const,
        job: retriedJob,
    };
}

export async function createEval(params: {
    jobId: string;
    validJson: boolean;
    hasRequiredFields: boolean;
    evidenceIncluded: boolean;
    evidenceSupported: boolean;
    reasonableRiskLabel: boolean;
    taskCompletionScore: number;
    notes: string;
}) {
    return prisma.eval.create({
        data: {
            jobId: params.jobId,
            validJson: params.validJson,
            hasRequiredFields: params.hasRequiredFields,
            evidenceIncluded: params.evidenceIncluded,
            evidenceSupported: params.evidenceSupported,
            reasonableRiskLabel: params.reasonableRiskLabel,
            taskCompletionScore: params.taskCompletionScore,
            notes: params.notes,
        },
    });
}

export async function addTrace(params: {
    jobId: string;
    stepName: string;
    input?: Prisma.InputJsonValue;
    output?: Prisma.InputJsonValue;
    latencyMs?: number;
}) {
    return prisma.trace.create({
        data: {
            jobId: params.jobId,
            stepName: params.stepName,
            input: params.input,
            output: params.output,
            latencyMs: params.latencyMs,
        },
    });
}

export async function getJobDetails(id: string) {
    const details = await prisma.job.findUnique({
        where: {
            id,
        },
        include: {
            traces: {
                orderBy: {
                    createdAt: "asc",
                },
            },
            evals: {
                orderBy: {
                    createdAt: "desc",
                },
                take: 1,
            },
        },
    });

    if (!details) {
        return null;
    }

    const { traces, evals, ...job } = details;

    return {
        job,
        traces,
        eval: evals[0] ?? null,
    };
}
