import "dotenv/config";
import {
    getFeatureUsage,
    getRetentionSummary,
    getSubscriptionHistory,
    getUserEvents,
} from "./analyticsTools.js";
import { addTrace, claimNextJob, completeJob } from "./jobs.js";

const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 2000);

console.log(`Worker polling every ${pollIntervalMs}ms`);

async function timed<T>(fn: () => Promise<T>) {
    const startedAt = Date.now();
    const output = await fn();

    return {
        output,
        latencyMs: Date.now() - startedAt,
    };
}

function getRiskLabel(summary: {
    activeDaysLast30: number;
    activeDaysPrevious30: number;
    supportTicketsLast30: number;
    npsScore: number;
}) {
    const activityDrop =
        summary.activeDaysPrevious30 - summary.activeDaysLast30;

    if (
        summary.npsScore <= 4 ||
        summary.supportTicketsLast30 >= 2 ||
        activityDrop >= 10
    ) {
        return "high";
    }

    if (summary.npsScore <= 6 || activityDrop >= 5) {
        return "medium";
    }

    return "low";
}

async function processJob(job: { id: string; input: unknown }) {
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

    const risk = getRiskLabel(retentionSummary.output);

    const result = {
        summary: `User ${userId} has ${risk} retention risk based on recent activity, feature usage,
          subscription state, and NPS.`,
        retentionRisk: risk,
        evidence: [
            `Active days changed from ${retentionSummary.output.activeDaysPrevious30} to
              ${retentionSummary.output.activeDaysLast30}.`,
            `Support tickets in last 30 days: ${retentionSummary.output.supportTicketsLast30}.`,
            `NPS score is ${retentionSummary.output.npsScore}.`,
        ],
        recommendedActions:
            risk === "high"
                ? [
                      "Schedule customer success outreach.",
                      "Offer a workflow review focused on underused features.",
                  ]
                : risk === "medium"
                  ? [
                        "Send targeted enablement content.",
                        "Monitor usage trend over the next week.",
                    ]
                  : [
                        "Continue normal lifecycle messaging.",
                        "Invite the user to try advanced features.",
                    ],
    };

    await addTrace({
        jobId: job.id,
        stepName: "mock_analysis",
        input: {
            events: events.output,
            featureUsage: featureUsage.output,
            subscriptionHistory: subscriptionHistory.output,
            retentionSummary: retentionSummary.output,
        },
        output: result,
        latencyMs: Date.now() - startedAt,
    });

    await completeJob({
        id: job.id,
        result,
        latencyMs: Date.now() - startedAt,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
    });

    console.log(`Completed job ${job.id}`);
}

async function poll() {
    const job = await claimNextJob();

    if (!job) return;

    console.log(`Claimed job ${job.id}`);

    await processJob(job);
}

setInterval(() => {
    poll().catch((error) => {
        console.error("Worker poll failed", error);
    });
}, pollIntervalMs);

await poll();
