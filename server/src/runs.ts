import type { Run } from "./generated/prisma/client.js";
import type { CreateRunInput } from "./types.js";

export type CreateRunResult =
    | { ok: true; run: Run; jobCount: number }
    | { ok: false; reason: "dataset_not_found" | "unknown_prompt_version" };

// TODO(ME): create the run and one job per case in a single transaction.
// - Find the dataset by name + version with its cases; none -> dataset_not_found.
// - promptVersionExists() in llm.ts false -> unknown_prompt_version, before
//   creating anything (a v999 would otherwise fail every job in the worker).
// - provider/model come from resolveLlm() in llm.ts.
// - Each job: type "retention_risk_analysis", runId, caseId, and input
//   { userId: snapshot.retentionSummary.userId, snapshot, promptVersion, expectedRisk }.
// - prisma.$transaction: run + jobs commit together or not at all.
export async function createRun(input: CreateRunInput): Promise<CreateRunResult> {
    throw new Error("createRun is not implemented yet");
}
