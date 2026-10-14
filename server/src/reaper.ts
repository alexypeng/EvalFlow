import "dotenv/config";
import { setTimeout as sleep } from "node:timers/promises";
import { prisma } from "./db.js";
import { reapExpiredJobs } from "./jobs.js";
import { reaperSettings } from "./reaperSettings.js";

const { intervalMs, batchSize } = reaperSettings(process.env);
const shutdown = new AbortController();
process.once("SIGTERM", () => shutdown.abort());
process.once("SIGINT", () => shutdown.abort());

console.log(`Reaper scanning every ${intervalMs}ms, up to ${batchSize} expired jobs per scan`);
try {
    while (!shutdown.signal.aborted) {
        try {
            const recovered = await reapExpiredJobs(batchSize);
            if (recovered.length > 0) {
                const queued = recovered.filter((job) => job.status === "queued").length;
                console.log(
                    `Reaper recovered ${recovered.length} jobs: ${queued} queued, ` +
                        `${recovered.length - queued} dead-lettered`,
                );
            }
        } catch (error) {
            console.error("Reaper scan failed", error);
        }
        // Sequential scans bound DB work, including during outages. Signals interrupt idle sleep.
        try {
            await sleep(intervalMs, undefined, { signal: shutdown.signal });
        } catch (error) {
            if (!shutdown.signal.aborted) throw error;
        }
    }
} finally {
    await prisma.$disconnect();
}
