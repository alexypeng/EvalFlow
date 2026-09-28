import { beforeEach, describe, it } from "vitest";
import { resetDatabase } from "./helpers.js";

// TODO(ME): seed with loadDataset(await readDatasetFile(...)) as datasets.test.ts does.
beforeEach(resetDatabase);

describe("createRun", () => {
    it.todo("creates one queued job per case, linked by runId and caseId");
    it.todo("puts userId, snapshot, promptVersion and expectedRisk in each job's input");
    it.todo("records promptVersion, provider and model on the run");
    it.todo("returns dataset_not_found and creates nothing for an unknown dataset");
    it.todo("returns unknown_prompt_version and creates nothing for a missing prompt file");
    it.todo("creates no run if a job insert fails (transaction rolls back)");
});

describe("buildRetentionPrompt", () => {
    it.todo("never includes the case's expectedRisk in the prompt");
});
