import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import {
    getFeatureUsage,
    getRetentionSummary,
    getSubscriptionHistory,
    getUserEvents,
} from "./analyticsTools.js";
import {
    addTrace,
    claimNextJob,
    completeJob,
    failOrRetryJob,
    createEval,
} from "./jobs.js";
import {
    parseLlmJson,
    validateRetentionOutput,
    scoreRetentionAnalysis,
} from "./evaluator.js";
import { buildRetentionPrompt, callLlm, geminiModel } from "./llm.js";

const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 2000);
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 1);

if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
        `WORKER_CONCURRENCY must be a positive integer (got "${process.env.WORKER_CONCURRENCY}")`,
    );
}

console.log(
    `Worker running ${concurrency} slot(s), polling every ${pollIntervalMs}ms when idle`,
);

async function timed<T>(fn: () => Promise<T>) {
    const startedAt = Date.now();
    const output = await fn();

    return {
        output,
        latencyMs: Date.now() - startedAt,
    };
}

async function processJob(job: {
    id: string;
    input: unknown;
    attempts: number;
    maxAttempts: number;
}) {
    const startedAt = Date.now();

    const input = job.input as { userId: string };
    const userId = input.userId;

    const events = await timed(() => getUserEvents(userId));
    await addTrace({
        jobId: job.id,
        stepName: "getUserEvents",
        input: { userId },
        output: events.output,
        latencyMs: events.latencyMs,
    });

    const featureUsage = await timed(() => getFeatureUsage(userId));
    await addTrace({
        jobId: job.id,
        stepName: "getFeatureUsage",
        input: { userId },
        output: featureUsage.output,
        latencyMs: featureUsage.latencyMs,
    });

    const subscriptionHistory = await timed(() =>
        getSubscriptionHistory(userId),
    );
    await addTrace({
        jobId: job.id,
        stepName: "getSubscriptionHistory",
        input: { userId },
        output: subscriptionHistory.output,
        latencyMs: subscriptionHistory.latencyMs,
    });

    const retentionSummary = await timed(() => getRetentionSummary(userId));
    await addTrace({
        jobId: job.id,
        stepName: "getRetentionSummary",
        input: { userId },
        output: retentionSummary.output,
        latencyMs: retentionSummary.latencyMs,
    });

    const snapshot = {
        events: events.output,
        featureUsage: featureUsage.output,
        subscriptionHistory: subscriptionHistory.output,
        retentionSummary: retentionSummary.output,
    };

    const prompt = buildRetentionPrompt(userId, snapshot);

    const llmCall = await timed(() => callLlm(prompt, snapshot));

    await addTrace({
        jobId: job.id,
        stepName: "llm_call",
        input: {
            provider: process.env.LLM_PROVIDER ?? "mock",
            model: process.env.LLM_PROVIDER === "gemini" ? geminiModel : null,
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
        throw new Error(
            `LLM output failed schema validation: ${validation.error.message}`,
        );
    }

    const evalResult = scoreRetentionAnalysis({
        output: validation.data,
        snapshot,
        validJson: parsed.validJson,
        hasRequiredFields: validation.success,
    });

    await createEval({
        jobId: job.id,
        validJson: evalResult.validJson,
        hasRequiredFields: evalResult.hasRequiredFields,
        evidenceIncluded: evalResult.evidenceIncluded,
        evidenceSupported: evalResult.evidenceSupported,
        reasonableRiskLabel: evalResult.reasonableRiskLabel,
        taskCompletionScore: evalResult.taskCompletionScore,
        notes: evalResult.notes,
    });

    await completeJob({
        id: job.id,
        result: validation.data,
        latencyMs: Date.now() - startedAt,
        promptTokens: llmCall.output.promptTokens,
        completionTokens: llmCall.output.completionTokens,
        totalTokens: llmCall.output.totalTokens,
        estimatedCost: llmCall.output.estimatedCost,
        evalScore: evalResult.taskCompletionScore,
    });

    console.log(`Completed job ${job.id}`);
}

// Claims and processes at most one job. Returns false if the queue was empty.
async function runOnce() {
    const job = await claimNextJob();

    if (!job) return false;

    console.log(`Claimed job ${job.id}`);

    try {
        await processJob(job);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        await failOrRetryJob({
            id: job.id,
            attempts: job.attempts,
            maxAttempts: job.maxAttempts,
            error: message,
        });

        console.error(`Job ${job.id} failed`, error);
    }

    return true;
}

// Previously this used setInterval(poll, pollIntervalMs). setInterval fires on
// a fixed clock and doesn't wait for the previous poll to finish, so if a job
// took longer than the interval a new poll started anyway and claimed another
// job. Concurrency was therefore accidental: it grew with job latency, with
// no upper bound. Now each slot is a sequential loop: it only claims its next
// job after the current one finishes, and only sleeps when the queue is
// empty. Total in-flight jobs per process is exactly WORKER_CONCURRENCY.
async function workerLoop(slot: number) {
    while (true) {
        try {
            const claimed = await runOnce();

            if (!claimed) {
                await sleep(pollIntervalMs);
            }
        } catch (error) {
            // e.g. the database is unreachable. Back off instead of spinning.
            console.error(`Worker slot ${slot} poll failed`, error);
            await sleep(pollIntervalMs);
        }
    }
}

await Promise.all(
    Array.from({ length: concurrency }, (_, slot) => workerLoop(slot)),
);
