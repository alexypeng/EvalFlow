import type { AnalyticsSnapshot } from "./types.js";

export type { AnalyticsSnapshot };

const users: Record<string, AnalyticsSnapshot> = {
    user_123: {
        events: [
            { event: "login", daysAgo: 2 },
            { event: "export_report", daysAgo: 18 },
            { event: "billing_page_view", daysAgo: 4 },
        ],
        featureUsage: [
            { feature: "dashboards", usesLast30Days: 3, previous30Days: 16 },
            { feature: "alerts", usesLast30Days: 0, previous30Days: 5 },
            { feature: "exports", usesLast30Days: 1, previous30Days: 6 },
        ],
        subscriptionHistory: [
            { plan: "pro", status: "active", changedAt: "2026-04-01" },
            {
                plan: "pro",
                status: "renewal_due",
                changedAt: "2026-06-20",
                note: "annual renewal upcoming",
            },
        ],
        retentionSummary: {
            userId: "user_123",
            activeDaysLast30: 4,
            activeDaysPrevious30: 18,
            supportTicketsLast30: 2,
            npsScore: 4,
        },
    },

    user_medium: {
        events: [
            { event: "login", daysAgo: 5 },
            { event: "view_dashboard", daysAgo: 8 },
            { event: "support_contact", daysAgo: 10 },
        ],
        featureUsage: [
            { feature: "dashboards", usesLast30Days: 9, previous30Days: 14 },
            { feature: "alerts", usesLast30Days: 2, previous30Days: 5 },
            { feature: "exports", usesLast30Days: 4, previous30Days: 8 },
        ],
        subscriptionHistory: [{ plan: "pro", status: "active", changedAt: "2026-03-18" }],
        retentionSummary: {
            userId: "user_medium",
            activeDaysLast30: 10,
            activeDaysPrevious30: 17,
            supportTicketsLast30: 1,
            npsScore: 6,
        },
    },

    user_healthy: {
        events: [
            { event: "login", daysAgo: 0 },
            { event: "create_dashboard", daysAgo: 1 },
            { event: "invite_teammate", daysAgo: 3 },
        ],
        featureUsage: [
            { feature: "dashboards", usesLast30Days: 24, previous30Days: 21 },
            { feature: "alerts", usesLast30Days: 8, previous30Days: 7 },
            { feature: "exports", usesLast30Days: 12, previous30Days: 9 },
        ],
        subscriptionHistory: [{ plan: "enterprise", status: "active", changedAt: "2026-01-12" }],
        retentionSummary: {
            userId: "user_healthy",
            activeDaysLast30: 22,
            activeDaysPrevious30: 20,
            supportTicketsLast30: 0,
            npsScore: 9,
        },
    },
};

function fallbackSnapshot(userId: string): AnalyticsSnapshot {
    return {
        events: [
            { event: "login", daysAgo: 12 },
            { event: "view_dashboard", daysAgo: 20 },
        ],
        featureUsage: [
            { feature: "dashboards", usesLast30Days: 4, previous30Days: 8 },
            { feature: "alerts", usesLast30Days: 1, previous30Days: 3 },
            { feature: "exports", usesLast30Days: 2, previous30Days: 5 },
        ],
        subscriptionHistory: [{ plan: "starter", status: "active", changedAt: "2026-02-09" }],
        retentionSummary: {
            userId,
            activeDaysLast30: 5,
            activeDaysPrevious30: 11,
            supportTicketsLast30: 1,
            npsScore: 5,
        },
    };
}

function getSnapshot(userId: string, caseSnapshot?: AnalyticsSnapshot) {
    return caseSnapshot ?? users[userId] ?? fallbackSnapshot(userId);
}

export async function getUserEvents(userId: string, caseSnapshot?: AnalyticsSnapshot) {
    return getSnapshot(userId, caseSnapshot).events;
}

export async function getFeatureUsage(userId: string, caseSnapshot?: AnalyticsSnapshot) {
    return getSnapshot(userId, caseSnapshot).featureUsage;
}

export async function getSubscriptionHistory(userId: string, caseSnapshot?: AnalyticsSnapshot) {
    return getSnapshot(userId, caseSnapshot).subscriptionHistory;
}

export async function getRetentionSummary(userId: string, caseSnapshot?: AnalyticsSnapshot) {
    return getSnapshot(userId, caseSnapshot).retentionSummary;
}
