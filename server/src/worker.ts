import "dotenv/config";
import { claimNextJob, completeJob } from "./jobs.js";

const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 2000);

console.log(`Worker polling every ${pollIntervalMs}ms`);

async function processJob(job: { id: string }) {
    const startedAt = Date.now();

    const mockResult = {
        summary:
            "User shows elevated retention risk based on declining product usage.",
        retentionRisk: "high",
        evidence: [
            "Active days declined compared with the previous period.",
            "Feature usage is down across core product areas.",
        ],
        recommendedActions: [
            "Send customer success outreach.",
            "Offer a workflow review focused on underused features.",
        ],
    };

    await completeJob(job.id, mockResult, Date.now() - startedAt);

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
