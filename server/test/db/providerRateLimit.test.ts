import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { prisma } from "../../src/db.js";
import { claimNextJob } from "../../src/jobs.js";
import { tryAcquireProviderPermit } from "../../src/providerRateLimit.js";
import { resetDatabase } from "./helpers.js";

beforeEach(resetDatabase);
async function lease() {
    await prisma.job.create({ data: { type: "test", input: {} } });
    return (await claimNextJob(randomUUID(), 60_000))!;
}
async function frozenBucket(provider = "mock", tokens = 2) {
    await prisma.$executeRaw`
        INSERT INTO provider_rate_limits (provider, tokens, refilled_at)
        VALUES (${provider}, ${tokens}, clock_timestamp() + interval '1 hour')
    `;
}

it("initializes a shared bucket once, allows the burst and denies empty-bucket requests", async () => {
    const job = await lease();
    expect(await tryAcquireProviderPermit(job, "mock")).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(await tryAcquireProviderPermit(job, "mock")).toEqual({ allowed: true, retryAfterMs: 0 });
    const denied = await tryAcquireProviderPermit(job, "mock");
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1000);
    expect(await prisma.providerRateLimit.count()).toBe(1);
    expect(await prisma.providerRateLimit.findUniqueOrThrow({ where: { provider: "mock" } })).toMatchObject({
        capacity: 2, refillPerSecond: 1,
    });
    expect((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).attempts).toBe(1);
});

it("spends each burst token once across concurrent jobs and uses provider buckets independently", async () => {
    await frozenBucket();
    const jobs = [];
    for (let i = 0; i < 20; i++) jobs.push(await lease());
    const results = await Promise.all(jobs.map((job) => tryAcquireProviderPermit(job, "mock")));
    expect(results.filter((result) => result.allowed)).toHaveLength(2);
    expect((await prisma.providerRateLimit.findUniqueOrThrow({ where: { provider: "mock" } })).tokens).toBe(0);
    expect(await tryAcquireProviderPermit(jobs[0], "gemini")).toMatchObject({ allowed: true });
    expect(await tryAcquireProviderPermit(jobs[0], "mock")).toMatchObject({ allowed: false });
});

it("refills using database time despite application clock skew, capped at capacity after a long idle", async () => {
    const job = await lease();
    await frozenBucket("mock", 0);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 120_000 });
    try {
        await prisma.$executeRaw`
            UPDATE provider_rate_limits SET refilled_at = clock_timestamp() - interval '0.5 second'
            WHERE provider = 'mock'
        `;
        const half = await tryAcquireProviderPermit(job, "mock");
        expect(half.allowed).toBe(false);
        expect(half.retryAfterMs).toBeGreaterThan(0);
        expect(half.retryAfterMs).toBeLessThanOrEqual(500);
        await prisma.$executeRaw`
            UPDATE provider_rate_limits SET refilled_at = clock_timestamp() - interval '1 day'
            WHERE provider = 'mock'
        `;
        expect((await tryAcquireProviderPermit(job, "mock")).allowed).toBe(true);
        const bucket = await prisma.providerRateLimit.findUniqueOrThrow({ where: { provider: "mock" } });
        expect(bucket.tokens).toBe(1);
        const [clock] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
        expect(bucket.refilledAt.getTime()).toBeLessThanOrEqual(clock.now.getTime());
    } finally { vi.useRealTimers(); }
});

it("shares cold-start creation without replenishing tokens for each caller", async () => {
    const jobs = [];
    for (let i = 0; i < 12; i++) jobs.push(await lease());
    const started = performance.now();
    const results = await Promise.all(jobs.map((job) => tryAcquireProviderPermit(job, "mock")));
    const elapsed = performance.now() - started;
    expect(results.filter((result) => result.allowed).length).toBeLessThanOrEqual(2 + Math.floor(elapsed / 1000));
    expect(await prisma.providerRateLimit.count()).toBe(1);
});

it.each(["expired", "replaced", "completed"])("rejects %s ownership without consuming tokens", async (state) => {
    const job = await lease();
    await frozenBucket();
    if (state === "expired") {
        await prisma.$executeRaw`
            UPDATE jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = ${job.id}::uuid
        `;
    } else if (state === "replaced") {
        await prisma.job.update({ where: { id: job.id }, data: { leaseToken: randomUUID() } });
    } else {
        await prisma.job.update({ where: { id: job.id }, data: { status: "completed" } });
    }
    const before = await prisma.providerRateLimit.findUniqueOrThrow({ where: { provider: "mock" } });
    await expect(tryAcquireProviderPermit(job, "mock")).rejects.toMatchObject({ name: "LeaseLostError" });
    expect(await prisma.providerRateLimit.findUniqueOrThrow({ where: { provider: "mock" } })).toEqual(before);
});

it("rechecks lease expiry after waiting on the shared bucket lock", async () => {
    const job = await lease();
    await frozenBucket();
    let notify!: () => void;
    const locked = new Promise<void>((resolve) => { notify = resolve; });
    const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT provider FROM provider_rate_limits WHERE provider = 'mock' FOR UPDATE`;
        await tx.$executeRaw`
            UPDATE jobs SET lease_expires_at = clock_timestamp() + interval '100 milliseconds'
            WHERE id = ${job.id}::uuid
        `;
        notify();
        await tx.$queryRaw`SELECT 1 AS waited FROM pg_sleep(0.25)`;
    });
    await locked;
    const acquire = tryAcquireProviderPermit(job, "mock");
    await expect(acquire).rejects.toMatchObject({ name: "LeaseLostError" });
    await holder;
    expect((await prisma.providerRateLimit.findUniqueOrThrow({ where: { provider: "mock" } })).tokens).toBe(2);
});

it("enforces valid persisted policy bounds", async () => {
    await expect(prisma.providerRateLimit.create({ data: { provider: "mock", refillPerSecond: 0 } })).rejects.toThrow();
    await expect(prisma.providerRateLimit.create({ data: { provider: "mock", capacity: 0 } })).rejects.toThrow();
    await expect(prisma.providerRateLimit.create({ data: { provider: "mock", tokens: -1 } })).rejects.toThrow();
});
