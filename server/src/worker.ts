import "dotenv/config";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { getFeatureUsage, getRetentionSummary, getSubscriptionHistory, getUserEvents } from "./analyticsTools.js";
import { addTrace, claimNextJob, completeJob, failOrRetryJob, renewJobLease } from "./jobs.js";
import { parseLlmJson, validateRetentionOutput, scoreRetentionAnalysis } from "./evaluator.js";
import { buildRetentionPrompt, callLlm, defaultPromptVersion, resolveLlm } from "./llm.js";
import { limitMockProvider, waitForProviderPermit } from "./providerRateLimit.js";
import { startHeartbeat, LeaseLostError } from "./heartbeat.js";
import { workerLeaseSettings, workerShutdownSettings } from "./leaseSettings.js";
import { prisma } from "./db.js";
import type { JobLease } from "./jobs.js";
import { JobInputSchema } from "./types.js";
import { createWorkerMetrics, workerMetricsPort } from "./workerMetrics.js";
import { shutdownTelemetry } from "./telemetry.js";
import { beginJobAttemptTrace } from "./jobTracing.js";
import type { AttemptOutcome } from "./workerMetrics.js";
import { tracePipelineStep } from "./pipelineTracing.js";
import { installHealthChecks } from "./health.js";

const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const workerId = randomUUID();
const { leaseDurationMs, heartbeatIntervalMs } = workerLeaseSettings(process.env);
const { graceMs, cleanupMs } = workerShutdownSettings(process.env);
const rateLimitMock = limitMockProvider(process.env);
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 1);
const metricsPort = workerMetricsPort(process.env);
const metrics = createWorkerMetrics();

if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`WORKER_CONCURRENCY must be a positive integer (got "${process.env.WORKER_CONCURRENCY}")`);
}

const idleSleep = new AbortController();
const active = new Map<string, {
    lease: JobLease;
    heartbeat: ReturnType<typeof startHeartbeat>;
    release: (error: string) => ReturnType<typeof failOrRetryJob>;
}>();
let stopping = false;
let abandoning = false;
let graceTimer: ReturnType<typeof setTimeout> | undefined;

async function abandonAndExit() {
    // Prevent late tool/model responses from starting new pipeline writes before releasing ownership.
    abandoning = true;
    console.error(`Worker shutdown deadline reached; abandoning ${active.size} active job(s)`);
    const hardStop = setTimeout(() => {
        console.error("Worker shutdown cleanup timed out; remaining leases will expire for the reaper");
        process.exit(1);
    }, cleanupMs);

    const outcomes = await Promise.allSettled([...active.values()].map(async ({ lease, heartbeat, release }) => {
        // Drain renewals before release, so a queued heartbeat cannot extend a released claim.
        await heartbeat.stop();
        const updated = await release("Worker shutdown deadline exceeded");
        console.log(
            updated ? `Shutdown released job ${lease.id}: ${updated.status}` : `Shutdown no longer owns ${lease.id}`,
        );
    }));
    for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
            console.error("Shutdown release failed; lease recovery left to reaper", outcome.reason);
        }
    }
    await metrics.app.close();
    await prisma.$disconnect();
    await shutdownTelemetry();
    clearTimeout(hardStop);
    // A provider call or claim query may still be pending; exit even when those handles remain open.
    process.exit(0);
}

function requestShutdown(signal: string) {
    if (stopping) return;
    stopping = true;
    idleSleep.abort();
    console.log(`Worker received ${signal}; stopping claims, draining for up to ${graceMs}ms`);
    graceTimer = setTimeout(() => {
        void abandonAndExit().catch((error) => {
            console.error("Worker shutdown cleanup failed; lease recovery left to reaper", error);
            process.exit(1);
        });
    }, graceMs);
}

process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGINT", () => requestShutdown("SIGINT"));

installHealthChecks(metrics.app, { isStopping: () => stopping });
await metrics.app.listen({ port: metricsPort, host: "0.0.0.0" });
const address = metrics.app.server.address();
console.log(`Worker metrics listening on port ${typeof address === "object" ? address?.port : metricsPort}`);

console.log(
    `Worker ${workerId} running ${concurrency} slot(s), polling every ${pollIntervalMs}ms when idle; ` +
        `lease ${leaseDurationMs}ms, heartbeat ${heartbeatIntervalMs}ms`,
);

async function timed<T>(fn: () => Promise<T>) {
    const startedAt = Date.now();
    const output = await fn();

    return {
        output,
        latencyMs: Date.now() - startedAt,
    };
}

async function processJob(
    job: JobLease & { caseId: string | null; input: unknown },
    assertActive: () => void,
    complete: typeof completeJob,
) {
    const startedAt = Date.now();
    const trace: typeof addTrace = (params) => {
        assertActive();
        return addTrace({ ...params, input: { ...(params.input as object), workerId, leaseToken: job.leaseToken } });
    };

    const {
        userId,
        snapshot: caseSnapshot,
        promptVersion = defaultPromptVersion,
        expectedRisk,
        mockConfig,
    } = JobInputSchema.parse(job.input);
    const toolInput = {
        userId,
        source: caseSnapshot ? "dataset_case" : "built_in_mock",
    };

    const events = await tracePipelineStep("tool.get_user_events", {}, () =>
        timed(() => getUserEvents(userId, caseSnapshot)),
    );
    await trace({
        jobId: job.id,
        stepName: "getUserEvents",
        input: toolInput,
        output: events.output,
        latencyMs: events.latencyMs,
    });

    const featureUsage = await tracePipelineStep("tool.get_feature_usage", {}, () =>
        timed(() => getFeatureUsage(userId, caseSnapshot)),
    );
    await trace({
        jobId: job.id,
        stepName: "getFeatureUsage",
        input: toolInput,
        output: featureUsage.output,
        latencyMs: featureUsage.latencyMs,
    });

    const subscriptionHistory = await tracePipelineStep("tool.get_subscription_history", {}, () =>
        timed(() => getSubscriptionHistory(userId, caseSnapshot)),
    );
    await trace({
        jobId: job.id,
        stepName: "getSubscriptionHistory",
        input: toolInput,
        output: subscriptionHistory.output,
        latencyMs: subscriptionHistory.latencyMs,
    });

    const retentionSummary = await tracePipelineStep("tool.get_retention_summary", {}, () =>
        timed(() => getRetentionSummary(userId, caseSnapshot)),
    );
    await trace({
        jobId: job.id,
        stepName: "getRetentionSummary",
        input: toolInput,
        output: retentionSummary.output,
        latencyMs: retentionSummary.latencyMs,
    });

    const snapshot = {
        events: events.output,
        featureUsage: featureUsage.output,
        subscriptionHistory: subscriptionHistory.output,
        retentionSummary: retentionSummary.output,
    };

    const prompt = await tracePipelineStep("prompt.build", { "evalflow.prompt.version": promptVersion }, () =>
        buildRetentionPrompt(userId, snapshot, promptVersion),
    );

    const { provider, model } = resolveLlm();
    if (provider === "gemini" || rateLimitMock) {
        const permit = await tracePipelineStep("provider.permit_wait", { "evalflow.provider": provider }, () =>
            metrics.measurePermitWait(provider, () =>
                timed(() => waitForProviderPermit(job, provider, { signal: idleSleep.signal, assertActive })),
            ),
        );
        await trace({
            jobId: job.id, stepName: "provider_rate_limit", input: { provider },
            output: { admitted: true, totalTokens: 0, estimatedCost: 0 }, latencyMs: permit.latencyMs,
        });
        // Shutdown can arrive while recording the wait trace, after the permit was granted.
        idleSleep.signal.throwIfAborted();
    }
    assertActive();
    const llmCall = await tracePipelineStep("llm.call", {
        "gen_ai.operation.name": "generate_content",
        "gen_ai.provider.name": provider === "gemini" ? "gcp.gemini" : "mock",
        "gen_ai.request.model": model,
        "evalflow.prompt.version": promptVersion,
    }, async (span) => {
        const result = await metrics.measureLlm(provider, () =>
            timed(() => callLlm(prompt, snapshot, { caseId: job.caseId ?? undefined, mockConfig })),
        );
        span.setAttributes({
            "gen_ai.usage.input_tokens": result.output.promptTokens,
            "gen_ai.usage.output_tokens": result.output.completionTokens,
            "evalflow.usage.total_tokens": result.output.totalTokens,
            "evalflow.usage.estimated": true,
            "evalflow.estimated_cost": result.output.estimatedCost,
        });
        return result;
    });

    await trace({
        jobId: job.id,
        stepName: "llm_call",
        input: {
            provider: llmCall.output.provider,
            model: llmCall.output.model,
            promptVersion,
            ...(mockConfig ? { mockConfig, caseId: job.caseId } : {}),
            prompt,
        },
        output: {
            text: llmCall.output.text,
            promptTokens: llmCall.output.promptTokens,
            completionTokens: llmCall.output.completionTokens,
            totalTokens: llmCall.output.totalTokens,
            estimatedCost: llmCall.output.estimatedCost,
        },
        latencyMs: llmCall.latencyMs,
    });

    const parsed = await tracePipelineStep("output.parse", {}, () => {
        const parsed = parseLlmJson(llmCall.output.text);
        if (!parsed.validJson) throw new Error("LLM returned invalid JSON");
        return parsed;
    });

    const validation = await tracePipelineStep("output.validate", {}, () => {
        const validation = validateRetentionOutput(parsed.parsed);
        if (!validation.success) {
            throw new Error(`LLM output failed schema validation: ${validation.error.message}`);
        }
        return validation;
    });

    const evalResult = await tracePipelineStep("evaluation.score", {}, (span) => {
        const result = scoreRetentionAnalysis({
            output: validation.data,
            snapshot,
            validJson: parsed.validJson,
            hasRequiredFields: validation.success,
            expectedRisk,
        });
        span.setAttributes({
            "evalflow.eval.score": result.taskCompletionScore,
            "evalflow.eval.label_correct": result.reasonableRiskLabel,
        });
        return result;
    });

    assertActive();
    const completed = await complete({
        ...job,
        result: validation.data,
        latencyMs: Date.now() - startedAt,
        promptTokens: llmCall.output.promptTokens,
        completionTokens: llmCall.output.completionTokens,
        totalTokens: llmCall.output.totalTokens,
        estimatedCost: llmCall.output.estimatedCost,
        evaluation: evalResult,
    });

    if (!completed) throw new LeaseLostError();
    console.log(`Completed job ${job.id}`);
}

async function runOnce() {
    const job = await metrics.measureClaim(() => claimNextJob(workerId, leaseDurationMs));

    if (!job) return false;

    const attemptTrace = beginJobAttemptTrace(job);
    return attemptTrace.run(async () => {
        const { finish: finishMetrics, finalize } = metrics.beginAttempt();
        const finish = (outcome: AttemptOutcome) => {
            finishMetrics(outcome);
            attemptTrace.finish(outcome);
        };
        const release = (error: string) => attemptTrace.run(() => finalize(async () => {
            try {
                const updated = await failOrRetryJob({ ...job, error });
                finish(updated ? updated.status === "queued" ? "retried" : "dead_letter" : "lease_lost");
                return updated;
            } catch (error) {
                finish("unconfirmed");
                throw error;
            }
        }));

        console.log(`Claimed job ${job.id}`);

        const heartbeat = startHeartbeat(heartbeatIntervalMs, () => renewJobLease(job, leaseDurationMs));
        active.set(job.id, { lease: job, heartbeat, release });
        try {
            // A claim already sent before SIGTERM can return afterwards. Release it without starting the pipeline.
            if (stopping) {
                await heartbeat.stop();
                await release("Worker shutdown before execution");
            } else {
                await processJob(job, () => {
                    if (abandoning) throw new LeaseLostError();
                    heartbeat.assertActive();
                }, (params) => finalize(async () => {
                    const completed = await completeJob(params);
                    if (completed) finish("completed");
                    return completed;
                }));
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            if (error instanceof LeaseLostError || abandoning) {
                if (!abandoning) finish("lease_lost");
                console.error(`Job ${job.id}: ${message}`);
            } else {
                const updated = await release(message);
                console.error(
                    updated ? `Job ${job.id}: ${updated.status}` : `Job ${job.id} lease lost; failure discarded`, error,
                );
            }
        } finally {
            try {
                await heartbeat.stop();
            } finally {
                active.delete(job.id);
                // Once deadline cleanup starts, it owns outcome recording even if the provider returns late.
                if (!abandoning) finish("unconfirmed");
            }
        }

        return true;
    });
}

async function workerLoop(slot: number) {
    while (!stopping) {
        try {
            const claimed = await runOnce();

            if (!claimed && !stopping) {
                await sleep(pollIntervalMs, undefined, { signal: idleSleep.signal });
            }
        } catch (error) {
            if (stopping) return;
            // Back off instead of spinning, e.g. while the database is down.
            console.error(`Worker slot ${slot} poll failed`, error);
            try {
                await sleep(pollIntervalMs, undefined, { signal: idleSleep.signal });
            } catch (sleepError) {
                if (!stopping) throw sleepError;
            }
        }
    }
}

await Promise.all(Array.from({ length: concurrency }, (_, slot) => workerLoop(slot)));
if (!abandoning) {
    // Keep the shutdown deadline armed until disconnect finishes; a stuck DB must not hang exit forever.
    await metrics.app.close();
    await prisma.$disconnect();
    await shutdownTelemetry();
    clearTimeout(graceTimer);
    console.log("Worker shutdown complete");
}
