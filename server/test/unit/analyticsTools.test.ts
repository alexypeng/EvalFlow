import { describe, expect, it } from "vitest";
import { getRetentionSummary, getUserEvents } from "../../src/analyticsTools.js";
import type { AnalyticsSnapshot } from "../../src/types.js";

const caseSnapshot: AnalyticsSnapshot = {
    events: [{ event: "login", daysAgo: 1 }],
    featureUsage: [],
    subscriptionHistory: [],
    retentionSummary: {
        userId: "case_user",
        activeDaysLast30: 9,
        activeDaysPrevious30: 9,
        supportTicketsLast30: 0,
        npsScore: 8,
    },
};

describe("analytics tools", () => {
    it("return the case snapshot when one is passed", async () => {
        expect(await getUserEvents("user_123", caseSnapshot)).toEqual(caseSnapshot.events);
        expect(await getRetentionSummary("user_123", caseSnapshot)).toEqual(caseSnapshot.retentionSummary);
    });

    it("fall back to the built-in mock users without a snapshot", async () => {
        const summary = await getRetentionSummary("user_123");

        expect(summary.userId).toBe("user_123");
        expect(summary.npsScore).toBe(4);
    });
});
