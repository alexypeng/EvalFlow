import { setTimeout as sleep } from "node:timers/promises";
import { prisma } from "./db.js";
import { ownsLease, type JobLease } from "./jobs.js";
import { LeaseLostError } from "./heartbeat.js";
import type { LlmProvider } from "./llm.js";

export function limitMockProvider(env: NodeJS.ProcessEnv) {
    const value = env.RATE_LIMIT_MOCK ?? "false";
    if (value !== "true" && value !== "false") throw new Error("RATE_LIMIT_MOCK must be true or false");
    return value === "true";
}

export async function tryAcquireProviderPermit(lease: JobLease, provider: LlmProvider) {
    return prisma.$transaction(async (tx) => {
        // Defaults/policy live in the shared row; worker restarts must not refill an existing bucket.
        await tx.$executeRaw`
            INSERT INTO provider_rate_limits (provider) VALUES (${provider}) ON CONFLICT (provider) DO NOTHING
        `;
        await tx.$queryRaw`SELECT provider FROM provider_rate_limits WHERE provider = ${provider} FOR UPDATE`;
        // Bucket lock first, then job lock/time check: waiting on either lock cannot preserve an expired claim.
        if (!(await ownsLease(tx, lease))) throw new LeaseLostError();
        const [result] = await tx.$queryRaw<Array<{ allowed: boolean; retryAfterMs: number }>>`
            WITH moment AS MATERIALIZED (SELECT clock_timestamp() AS now),
            refill AS MATERIALIZED (
                SELECT provider, refill_per_second, GREATEST(refilled_at, moment.now) AS now,
                    LEAST(capacity::double precision,
                        tokens + GREATEST(0, EXTRACT(EPOCH FROM (moment.now - refilled_at))) * refill_per_second
                    ) AS available
                FROM provider_rate_limits CROSS JOIN moment WHERE provider = ${provider}
            )
            UPDATE provider_rate_limits AS bucket
            SET tokens = CASE WHEN refill.available >= 1 THEN refill.available - 1 ELSE refill.available END,
                refilled_at = refill.now
            FROM refill WHERE bucket.provider = refill.provider
            RETURNING refill.available >= 1 AS allowed,
                CASE WHEN refill.available >= 1 THEN 0
                    ELSE ceil((1 - refill.available) / refill.refill_per_second * 1000)::int
                END AS "retryAfterMs"
        `;
        return result;
    });
}

export async function waitForProviderPermit(
    lease: JobLease,
    provider: LlmProvider,
    options: { signal: AbortSignal; assertActive: () => void },
) {
    while (true) {
        options.signal.throwIfAborted();
        options.assertActive();
        const result = await tryAcquireProviderPermit(lease, provider);
        // A signal may arrive during a DB operation. A granted permit is never refunded or used after cancellation.
        options.signal.throwIfAborted();
        options.assertActive();
        if (result.allowed) return;
        // No lock/transaction is held during sleep. Recheck ownership promptly even for slow refill policies.
        await sleep(Math.min(result.retryAfterMs, 250), undefined, { signal: options.signal });
    }
}
