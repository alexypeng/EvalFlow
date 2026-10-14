import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { createJob } from "../../src/jobs.js";
import { resetDatabase } from "./helpers.js";

beforeEach(resetDatabase);

it("creates unowned queued jobs with an immediately eligible runAfter default", async () => {
    const job = await createJob("retention_risk_analysis", { userId: "case_user" });
    const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() AS now`;
    expect(job.status).toBe("queued");
    expect(job.lockedBy).toBeNull();
    expect(job.leaseToken).toBeNull();
    expect(job.leaseExpiresAt).toBeNull();
    expect(job.runAfter.getTime()).toBeLessThanOrEqual(clock.now.getTime());
    expect(job.runAfter.getTime()).toBeGreaterThanOrEqual(job.createdAt.getTime() - 1000);
});

it("stores independent worker/claim identities and preserves the scheduling and expiry timestamps", async () => {
    const job = await createJob("retention_risk_analysis", { userId: "case_user" });
    const lockedBy = randomUUID();
    const leaseToken = randomUUID();
    const runAfter = new Date("2030-01-01T00:00:00.123Z");
    const leaseExpiresAt = new Date("2030-01-01T00:00:30.456Z");
    await prisma.job.update({ where: { id: job.id }, data: { lockedBy, leaseToken, runAfter, leaseExpiresAt } });
    const saved = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(saved).toMatchObject({ lockedBy, leaseToken, runAfter, leaseExpiresAt });
    expect(saved.attempts).toBe(0);
    expect(saved.status).toBe("queued");
});
