import { z } from "zod";
import { MockConfigSchema, PromptVersionSchema } from "./types.js";

const BaselineCaseSchema = z.object({
    caseName: z.string().min(1),
    outcome: z.enum(["pass", "fail"]),
    score: z.number().min(0).max(100).nullable(),
}).strict().refine((item) => item.outcome !== "pass" || item.score !== null, {
    message: "A passing case must have a score",
});

export const BaselineSchema = z.object({
    formatVersion: z.literal(1),
    dataset: z.object({ name: z.string().min(1), version: z.number().int().positive() }).strict(),
    run: z.object({
        promptVersion: PromptVersionSchema,
        provider: z.enum(["mock", "gemini"]),
        model: z.string().min(1),
        mockConfig: MockConfigSchema.optional(),
    }).strict().refine((run) => run.provider === "mock" || run.mockConfig === undefined, {
        message: "Gemini baselines cannot contain mock settings",
    }).refine((run) => run.provider !== "mock" || run.mockConfig !== undefined, {
        message: "Mock baselines must contain saved mock settings",
    }),
    cases: z.array(BaselineCaseSchema).min(1).refine(
        (cases) => new Set(cases.map((item) => item.caseName)).size === cases.length,
        { message: "Case names must be unique" },
    ),
}).strict();

export type Baseline = z.infer<typeof BaselineSchema>;
