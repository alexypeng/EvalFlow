import "dotenv/config";
import { claimNextJob } from "./jobs.js";

const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 2000);

console.log(`Worker polling every ${pollIntervalMs}ms`);

async function poll() {
    const job = await claimNextJob();

    if (!job) return;

    console.log(`Claimed job ${job.id}`);
}

setInterval(() => {
    poll().catch((error) => {
        console.error("Worker poll failed", error);
    });
}, pollIntervalMs);

await poll();
