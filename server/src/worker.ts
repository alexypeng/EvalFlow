import "dotenv/config";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { getFeatureUsage, getRetentionSummary, getSubscriptionHistory, getUserEvents } from "./analyticsTools.js";
import { addTrace, claimNextJob, completeJob, failOrRetryJob, renewJobLease } from "./jobs.js";
import { parseLlmJson, validateRetentionOutput, scoreRetentionAnalysis } from "./evaluator.js";
import { buildRetentionPrompt, callLlm, defaultPromptVersion } from "./llm.js";
import { startHeartbeat, LeaseLostError } from "./heartbeat.js";
import { workerLeaseSettings } from "./leaseSettings.js";
import type { JobLease } from "./jobs.js";
import { JobInputSchema } from "./types.js";

const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const workerId = randomUUID();
const { leaseDurationMs, heartbeatIntervalMs } = workerLeaseSettings(process.env);
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 1);

if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`WORKER_CONCURRENCY must be a positive integer (got "${process.env.WORKER_CONCURRENCY}")`);
}

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

    const events = await timed(() => getUserEvents(userId, caseSnapshot));
    await trace({
        jobId: job.id,
        stepName: "getUserEvents",
        input: toolInput,
        output: events.output,
        latencyMs: events.latencyMs,
    });

    const featureUsage = await timed(() => getFeatureUsage(userId, caseSnapshot));
    await trace({
        jobId: job.id,
        stepName: "getFeatureUsage",
        input: toolInput,
        output: featureUsage.output,
        latencyMs: featureUsage.latencyMs,
    });

    const subscriptionHistory = await timed(() => getSubscriptionHistory(userId, caseSnapshot));
    await trace({
        jobId: job.id,
        stepName: "getSubscriptionHistory",
        input: toolInput,
        output: subscriptionHistory.output,
        latencyMs: subscriptionHistory.latencyMs,
    });

    const retentionSummary = await timed(() => getRetentionSummary(userId, caseSnapshot));
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

    const prompt = await buildRetentionPrompt(userId, snapshot, promptVersion);

    assertActive();
    const llmCall = await timed(() => callLlm(prompt, snapshot, { caseId: job.caseId ?? undefined, mockConfig }));

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

    const parsed = parseLlmJson(llmCall.output.text);

    if (!parsed.validJson) {
        throw new Error("LLM returned invalid JSON");
    }

    const validation = validateRetentionOutput(parsed.parsed);

    if (!validation.success) {
        throw new Error(`LLM output failed schema validation: ${validation.error.message}`);
    }

    const evalResult = scoreRetentionAnalysis({
        output: validation.data,
        snapshot,
        validJson: parsed.validJson,
        hasRequiredFields: validation.success,
        expectedRisk,
    });

    assertActive();
    const completed = await completeJob({
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
    const job = await claimNextJob(workerId, leaseDurationMs);

    if (!job) return false;

    console.log(`Claimed job ${job.id}`);

    const heartbeat = startHeartbeat(heartbeatIntervalMs, () => renewJobLease(job, leaseDurationMs));
    try {
        await processJob(job, heartbeat.assertActive);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (error instanceof LeaseLostError) {
            console.error(`Job ${job.id}: ${message}`);
        } else {
            const updated = await failOrRetryJob({ ...job, error: message });
            console.error(
                updated ? `Job ${job.id}: ${updated.status}` : `Job ${job.id} lease lost; failure discarded`, error,
            );
        }
    } finally {
        await heartbeat.stop();
    }

    return true;
}

async function workerLoop(slot: number) {
    while (true) {
        try {
            const claimed = await runOnce();

            if (!claimed) {
                await sleep(pollIntervalMs);
            }
        } catch (error) {
            // Back off instead of spinning, e.g. while the database is down.
            console.error(`Worker slot ${slot} poll failed`, error);
            await sleep(pollIntervalMs);
        }
    }
}

await Promise.all(Array.from({ length: concurrency }, (_, slot) => workerLoop(slot)));
