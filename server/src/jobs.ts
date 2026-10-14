import { randomUUID } from "node:crypto";
import { Prisma, type JobStatus } from "./generated/prisma/client.js";
import { prisma } from "./db.js";
import { validateLeaseDuration } from "./leaseSettings.js";

// Equal jitter: wait between half and all of the exponential ceiling (2s, 4s, ... up to 30s).
// Clamp the exponent before calculating it so large attempt counts cannot overflow.
const automaticRetryAt = Prisma.sql`
    date_trunc('milliseconds', clock_timestamp()) +
    CASE WHEN attempts < max_attempts THEN
        floor(LEAST(30000, 2000 * power(2, LEAST(4, GREATEST(attempts - 1, 0)))) * (0.5 + random() * 0.5))
    ELSE 0 END * interval '1 millisecond'
`;

export async function createJob(type: string, input: Prisma.InputJsonValue, maxAttempts = 3) {
    return prisma.job.create({
        data: {
            type,
            input,
            maxAttempts,
            status: "queued",
        },
    });
}

export async function listJobs(status?: JobStatus) {
    return prisma.job.findMany({
        where: status ? { status } : undefined,
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
    const [totalJobs, completedJobs, failedJobs, aggregates] = await Promise.all([
        prisma.job.count(),
        prisma.job.count({
            where: { status: "completed" },
        }),
        prisma.job.count({
            where: { status: "dead_letter" },
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
        // Retain the metrics contract: this counts terminal execution failures, now called dead_letter.
        failedJobs,
        averageLatencyMs: aggregates._avg.latencyMs,
        averageEvalScore: aggregates._avg.evalScore,
        totalTokens: aggregates._sum.totalTokens ?? 0,
    };
}

export interface JobLease {
    id: string;
    lockedBy: string;
    leaseToken: string;
}

export async function reapExpiredJobs(batchSize = 100) {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
        throw new Error("REAPER_BATCH_SIZE must be an integer between 1 and 1000");
    }
    // Lock candidates before changing ownership. Other reapers skip these rows;
    // heartbeats/finalization serialize on the same locks and recheck ownership.
    return prisma.$queryRaw<Array<{ id: string; status: "queued" | "dead_letter" }>>`
        WITH expired AS (
            SELECT id FROM jobs
            WHERE status = 'running' AND lease_expires_at <= clock_timestamp()
            ORDER BY lease_expires_at ASC, id ASC
            FOR UPDATE SKIP LOCKED LIMIT ${batchSize}
        )
        UPDATE jobs AS job
        SET status = CASE WHEN job.attempts < job.max_attempts
                THEN 'queued'::"JobStatus" ELSE 'dead_letter'::"JobStatus" END,
            error = 'Worker lease expired',
            completed_at = CASE WHEN job.attempts < job.max_attempts THEN NULL ELSE clock_timestamp() END,
            run_after = ${automaticRetryAt},
            locked_by = NULL, lease_token = NULL, lease_expires_at = NULL
        FROM expired WHERE job.id = expired.id
        RETURNING job.id, job.status
    `;
}

export interface JobEvaluation {
    validJson: boolean;
    hasRequiredFields: boolean;
    evidenceIncluded: boolean;
    evidenceSupported: boolean;
    reasonableRiskLabel: boolean;
    taskCompletionScore: number;
    notes: string;
}

export async function claimNextJob(lockedBy: string, leaseDurationMs: number) {
    validateLeaseDuration(leaseDurationMs);
    const leaseToken = randomUUID();
    const jobs = await prisma.$queryRaw<
        Array<JobLease & {
            caseId: string | null;
            input: unknown;
            status: string;
            attempts: number;
            maxAttempts: number;
            startedAt: Date;
            leaseExpiresAt: Date;
        }>
    >`
        UPDATE jobs
        SET status = 'running', attempts = attempts + 1,
            started_at = clock_timestamp(), completed_at = NULL, error = NULL,
            locked_by = ${lockedBy}::uuid, lease_token = ${leaseToken}::uuid,
            lease_expires_at = clock_timestamp() + ${leaseDurationMs} * interval '1 millisecond'
        WHERE id = (
            SELECT id FROM jobs
            WHERE status = 'queued' AND run_after <= clock_timestamp() AND attempts < max_attempts
            ORDER BY created_at ASC, id ASC
            FOR UPDATE SKIP LOCKED LIMIT 1
        )
        RETURNING id, case_id AS "caseId", input, status, attempts, max_attempts AS "maxAttempts",
            started_at AS "startedAt", locked_by AS "lockedBy", lease_token AS "leaseToken",
            lease_expires_at AS "leaseExpiresAt"
    `;
    return jobs[0] ?? null;
}

// Lock first, then check database time: waiting for a row lock must not keep an expired lease valid.
async function ownsLease(tx: Prisma.TransactionClient, lease: JobLease) {
    await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${lease.id}::uuid FOR UPDATE`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM jobs WHERE id = ${lease.id}::uuid AND status = 'running'
            AND locked_by = ${lease.lockedBy}::uuid AND lease_token = ${lease.leaseToken}::uuid
            AND lease_expires_at > clock_timestamp()
    `;
    return rows.length === 1;
}

export async function renewJobLease(lease: JobLease, leaseDurationMs: number) {
    validateLeaseDuration(leaseDurationMs);
    return prisma.$transaction(async (tx) => {
        if (!(await ownsLease(tx, lease))) return false;
        await tx.$executeRaw`
            UPDATE jobs SET lease_expires_at = clock_timestamp() + ${leaseDurationMs} * interval '1 millisecond'
            WHERE id = ${lease.id}::uuid
        `;
        return true;
    });
}

export async function completeJob(params: JobLease & {
    result: Prisma.InputJsonValue;
    latencyMs: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCost: number;
    evaluation: JobEvaluation;
}) {
    return prisma.$transaction(async (tx) => {
        if (!(await ownsLease(tx, params))) return null;
        await tx.$executeRaw`UPDATE jobs SET completed_at = clock_timestamp() WHERE id = ${params.id}::uuid`;
        const job = await tx.job.update({
            where: { id: params.id },
            data: {
                status: "completed",
                result: params.result,
                latencyMs: params.latencyMs,
                promptTokens: params.promptTokens,
                completionTokens: params.completionTokens,
                totalTokens: params.totalTokens,
                estimatedCost: params.estimatedCost,
                evalScore: params.evaluation.taskCompletionScore,
                lockedBy: null,
                leaseToken: null,
                leaseExpiresAt: null,
            },
        });
        // A rejected claim cannot create an eval; a failed eval insert rolls back the result too.
        await tx.eval.create({ data: { jobId: params.id, ...params.evaluation } });
        return job;
    });
}

export async function failOrRetryJob(params: JobLease & { error: string }) {
    return prisma.$transaction(async (tx) => {
        if (!(await ownsLease(tx, params))) return null;
        await tx.$executeRaw`
            UPDATE jobs SET status = CASE WHEN attempts < max_attempts
                THEN 'queued'::"JobStatus" ELSE 'dead_letter'::"JobStatus" END,
                error = ${params.error},
                completed_at = CASE WHEN attempts < max_attempts THEN NULL ELSE clock_timestamp() END,
                run_after = ${automaticRetryAt},
                locked_by = NULL, lease_token = NULL, lease_expires_at = NULL
            WHERE id = ${params.id}::uuid
        `;
        return tx.job.findUniqueOrThrow({ where: { id: params.id } });
    });
}

export async function retryJob(id: string) {
    return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${id}::uuid FOR UPDATE`;
        const job = await tx.job.findUnique({ where: { id } });
        if (!job) return { ok: false as const, reason: "not_found" as const };
        if (job.status !== "dead_letter") return { ok: false as const, reason: "not_dead_letter" as const, job };
        await tx.$executeRaw`
            UPDATE jobs SET run_after = date_trunc('milliseconds', clock_timestamp()) WHERE id = ${id}::uuid
        `;
        const retriedJob = await tx.job.update({
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
                lockedBy: null,
                leaseToken: null,
                leaseExpiresAt: null,
            },
        });
        return { ok: true as const, job: retriedJob };
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
