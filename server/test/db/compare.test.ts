import { beforeEach, describe, it } from "vitest";
import { resetDatabase } from "./helpers.js";

// TODO(ME): implement these. Helpers in ./helpers.js:
// - startRun(promptVersion?) starts a run of retention v1. Call it twice for a
//   baseline and a candidate; the dataset is only loaded once.
// - jobForCase(runId, caseName) finds a run's job for one case, e.g.
//   jobForCase(baseline.id, "boundary_nps_4").
// - finishJob(jobId, { labelCorrect, score, latencyMs }) completes a job as the
//   worker would. labelCorrect decides pass/fail.
// - prisma.job.update({ where: { id }, data: { status: "failed" } }) fails a job.

beforeEach(resetDatabase);

describe("compareRuns", () => {
    // Use a valid UUID that matches no run, for either argument.
    it.todo("returns run_not_found when either run doesn't exist");

    // Load a second version of the dataset: readDatasetFile(retentionV1), set
    // version: 2, loadDataset, then createRun with datasetVersion 2.
    it.todo("returns different_datasets for runs of different datasets");

    // Two fresh runs: 20 rows, sorted by caseName, every change "pending",
    // summary.pending 20 and every other count 0.
    it.todo("returns one row per case, sorted by case name");

    // Same case: baseline labelCorrect true, candidate false -> "regression".
    it.todo("marks pass -> fail as a regression");

    // Same case: baseline false, candidate true -> "improvement".
    it.todo("marks fail -> pass as an improvement");

    // Both pass; baseline score 100, candidate 80 -> "warning". Also check a
    // case where both pass with equal scores stays "unchanged".
    it.todo("marks a lower score that still passes as a warning");

    // Baseline passes, candidate's job is set to status "failed" -> "regression".
    it.todo("treats a failed job as a fail");

    // Baseline passes, candidate's job still queued -> "pending", not a regression.
    it.todo("marks a case pending while either job is unfinished");

    // Set up one case of each kind, then check summary counts match the rows.
    it.todo("summarises the number of cases in each category");
});
