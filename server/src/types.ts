import { z } from "zod";

export const CreateJobSchema = z.object({
    type: z.literal("retention_risk_analysis"),
    input: z.object({
        userId: z.string().min(1),
    }),
    maxAttempts: z.number().int().min(1).max(10).optional(),
});

export type CreateJobInput = z.infer<typeof CreateJobSchema>;

export const RetentionAnalysisSchema = z.object({
    summary: z.string(),
    retentionRisk: z.enum(["low", "medium", "high"]),
    evidence: z.array(z.string()).min(1),
    recommendedActions: z.array(z.string()).min(1),
});

export type RetentionAnalysis = z.infer<typeof RetentionAnalysisSchema>;

export const AnalyticsSnapshotSchema = z.object({
    events: z.array(
        z.object({
            event: z.string(),
            daysAgo: z.number().int().min(0),
        }),
    ),
    featureUsage: z.array(
        z.object({
            feature: z.string(),
            usesLast30Days: z.number().int().min(0),
            previous30Days: z.number().int().min(0),
        }),
    ),
    subscriptionHistory: z.array(
        z.object({
            plan: z.string(),
            status: z.string(),
            changedAt: z.string(),
            note: z.string().optional(),
        }),
    ),
    retentionSummary: z.object({
        userId: z.string().min(1),
        activeDaysLast30: z.number().int().min(0).max(30),
        activeDaysPrevious30: z.number().int().min(0).max(30),
        supportTicketsLast30: z.number().int().min(0),
        npsScore: z.number().int().min(0).max(10),
    }),
});

export type AnalyticsSnapshot = z.infer<typeof AnalyticsSnapshotSchema>;

// What the worker reads from job.input. Jobs created by a run carry their
// dataset case's snapshot; dashboard jobs only have a userId.
export const JobInputSchema = z.object({
    userId: z.string().min(1),
    snapshot: AnalyticsSnapshotSchema.optional(),
});

export type JobInput = z.infer<typeof JobInputSchema>;

export const DatasetFileSchema = z
    .object({
        name: z.string().min(1),
        version: z.number().int().min(1),
        cases: z
            .array(
                z.object({
                    name: z.string().min(1),
                    // Why the case has its label. For reviewers; not stored.
                    note: z.string().optional(),
                    expectedRisk: z.enum(["low", "medium", "high"]),
                    snapshot: AnalyticsSnapshotSchema,
                }),
            )
            .min(1),
    })
    .refine(
        (file) =>
            new Set(file.cases.map((c) => c.name)).size === file.cases.length,
        {
            message: "Case names must be unique within a dataset",
        },
    );

export type DatasetFile = z.infer<typeof DatasetFileSchema>;
