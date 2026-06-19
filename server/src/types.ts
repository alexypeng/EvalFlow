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
