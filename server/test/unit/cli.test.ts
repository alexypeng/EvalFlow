import { describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cliRun.js";
import { MockConfigSchema } from "../../src/types.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runId = "00000000-0000-4000-8000-000000000001";
const args = ["run", "--dataset", "retention", "--poll-ms", "1"];
function report(finished = true) {
    return {
        run: { id: runId, provider: "mock", model: "mock-rule-based" },
        status: finished ? "finished" : "in_progress",
        jobs: { total: 2, queued: finished ? 0 : 1, running: 0, completed: 1, failed: finished ? 1 : 0 },
        passed: 1, passRate: 0.5, meanScore: 100,
        latencyMs: { p50: 10, p95: 10 }, totalTokens: 20, totalCost: 0,
    };
}
function harness() {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const out = vi.fn();
    const error = vi.fn();
    return { fetch, out, error };
}
function created() {
    return Response.json({ ok: true, run: { id: runId }, jobCount: 2 }, { status: 201 });
}

function baseline() {
    return {
        formatVersion: 1,
        dataset: { name: "retention", version: 1 },
        run: {
            promptVersion: "v1", provider: "mock", model: "mock-rule-based", mockConfig: MockConfigSchema.parse({}),
        },
        cases: [
            { caseName: "healthy", outcome: "pass", score: 100 },
            { caseName: "judgment", outcome: "fail", score: 80 },
        ],
    };
}

describe("evalflow regression gate CLI", () => {
    async function withFile(body: unknown, callback: (path: string) => Promise<void>) {
        const directory = await mkdtemp(join(tmpdir(), "evalflow-gate-"));
        const path = join(directory, "baseline.json");
        try {
            await writeFile(path, typeof body === "string" ? body : JSON.stringify(body));
            await callback(path);
        } finally {
            await rm(directory, { recursive: true });
        }
    }

    it.each([false, true])("returns the regression exit code and emits case changes (regression=%s)", async (regression) => {
        await withFile(baseline(), async (path) => {
            const candidate = baseline();
            candidate.cases[0] = { caseName: "healthy", outcome: regression ? "fail" : "pass", score: 80 };
            const io = harness();
            io.fetch.mockResolvedValueOnce(created()).mockResolvedValueOnce(Response.json(report()))
                .mockResolvedValueOnce(Response.json(candidate));
            expect(await runCli([...args, "--baseline", path], io)).toBe(regression ? 1 : 0);
            const output = JSON.parse(io.out.mock.calls[0][0]);
            expect(output.comparison.summary).toEqual({
                regression: regression ? 1 : 0, warning: regression ? 0 : 1, improvement: 0, unchanged: 1,
            });
            expect(io.fetch).toHaveBeenCalledTimes(3);
            expect(String(io.fetch.mock.calls[2][0])).toBe(`http://localhost:3000/runs/${runId}/baseline`);
        });
    });

    it.each(["{bad json", {}, { ...baseline(), dataset: { name: "other", version: 1 } }])(
        "rejects invalid or incompatible files before run creation: %j", async (body) => {
            await withFile(body, async (path) => {
                const io = harness();
                expect(await runCli([...args, "--baseline", path], io)).toBe(2);
                expect(io.fetch).not.toHaveBeenCalled();
                expect(io.out).not.toHaveBeenCalled();
            });
        },
    );

    it("returns error 2 for a different case set after the run finishes", async () => {
        await withFile(baseline(), async (path) => {
            const candidate = baseline();
            candidate.cases[0].caseName = "unexpected";
            const io = harness();
            io.fetch.mockResolvedValueOnce(created()).mockResolvedValueOnce(Response.json(report()))
                .mockResolvedValueOnce(Response.json(candidate));
            expect(await runCli([...args, "--baseline", path], io)).toBe(2);
            expect(io.out).not.toHaveBeenCalled();
            expect(io.error.mock.calls.at(-1)![0]).toContain("Case names do not match");
        });
    });

    it("loads a baseline run by ID before creating a candidate", async () => {
        const baselineId = "00000000-0000-4000-8000-000000000002";
        const io = harness();
        io.fetch.mockResolvedValueOnce(Response.json(baseline())).mockResolvedValueOnce(created())
            .mockResolvedValueOnce(Response.json(report())).mockResolvedValueOnce(Response.json(baseline()));
        expect(await runCli([...args, "--baseline", baselineId], io)).toBe(0);
        expect(String(io.fetch.mock.calls[0][0])).toBe(`http://localhost:3000/runs/${baselineId}/baseline`);
        expect(io.fetch.mock.calls[1][1]!.method).toBe("POST");
    });

    it("does not create a candidate when the baseline run is unfinished", async () => {
        const io = harness();
        io.fetch.mockResolvedValue(Response.json({ error: "Unfinished baseline" }, { status: 409 }));
        expect(await runCli([...args, "--baseline", runId], io)).toBe(2);
        expect(io.fetch).toHaveBeenCalledTimes(1);
        expect(io.fetch.mock.calls[0][1]!.method).toBeUndefined();
    });
});

describe("evalflow baseline export CLI", () => {
    it("exports validated portable JSON to stdout without creating a run", async () => {
        const io = harness();
        io.fetch.mockResolvedValue(Response.json(baseline()));
        expect(await runCli(["baseline", "export", runId], io)).toBe(0);
        expect(String(io.fetch.mock.calls[0][0])).toBe(`http://localhost:3000/runs/${runId}/baseline`);
        expect(io.fetch).toHaveBeenCalledTimes(1);
        expect(io.fetch.mock.calls[0][1]!.method).toBeUndefined();
        expect(JSON.parse(io.out.mock.calls[0][0])).toEqual(baseline());
    });

    it("writes a new file and refuses to overwrite an existing baseline", async () => {
        const directory = await mkdtemp(join(tmpdir(), "evalflow-baseline-"));
        const output = join(directory, "baseline.json");
        const io = harness();
        io.fetch.mockImplementation(async () => Response.json(baseline()));
        try {
            const input = ["baseline", "export", runId, "--output", output];
            expect(await runCli(input, io)).toBe(0);
            expect(JSON.parse(await readFile(output, "utf8"))).toEqual(baseline());
            expect(io.out).not.toHaveBeenCalled();
            await writeFile(output, "original baseline");
            expect(await runCli(input, io)).toBe(2);
            expect(await readFile(output, "utf8")).toBe("original baseline");
        } finally {
            await rm(directory, { recursive: true });
        }
    });

    it.each([
        { ...baseline(), formatVersion: 2 },
        { ...baseline(), cases: [{ caseName: "healthy", outcome: "pending", score: null }] },
        { ...baseline(), cases: [baseline().cases[0], baseline().cases[0]] },
        { ...baseline(), cases: [{ caseName: "healthy", outcome: "pass", score: null }] },
    ])("rejects invalid baseline responses before emitting JSON: %j", async (body) => {
        const io = harness();
        io.fetch.mockResolvedValue(Response.json(body));
        expect(await runCli(["baseline", "export", runId], io)).toBe(2);
        expect(io.out).not.toHaveBeenCalled();
    });

    it("reports unfinished run errors without exporting a baseline", async () => {
        const io = harness();
        io.fetch.mockResolvedValue(Response.json({ error: "Run is unfinished" }, { status: 409 }));
        expect(await runCli(["baseline", "export", runId], io)).toBe(2);
        expect(io.out).not.toHaveBeenCalled();
        expect(io.error.mock.calls[0][0]).toContain("409: Run is unfinished");
    });

    it.each([
        ["baseline", "export", "bad-id"],
        ["baseline", "export", runId, "--dataset", "retention"],
        ["baseline", "export", runId, "--output", ""],
    ])("rejects invalid export arguments before calling the API: %j", async (...input) => {
        const io = harness();
        expect(await runCli(input, io)).toBe(2);
        expect(io.fetch).not.toHaveBeenCalled();
    });
});

describe("evalflow run CLI", () => {
    it("keeps polling when pass counts advance between the API's separate report queries", async () => {
        const io = harness();
        const progress = { ...report(false), passed: 2, passRate: 1 };
        io.fetch.mockResolvedValueOnce(created()).mockResolvedValueOnce(Response.json(progress))
            .mockResolvedValueOnce(Response.json(report()));
        expect(await runCli(args, io)).toBe(0);
        expect(io.fetch).toHaveBeenCalledTimes(3);
        expect(JSON.parse(io.out.mock.calls[0][0]).status).toBe("finished");
    });

    it("creates once, polls until terminal, and separates report JSON from progress", async () => {
        const io = harness();
        io.fetch.mockResolvedValueOnce(created())
            .mockResolvedValueOnce(Response.json(report(false)))
            .mockResolvedValueOnce(Response.json(report()));

        expect(await runCli([...args, "--prompt", "v2", "--dataset-version", "3"], io)).toBe(0);
        expect(io.fetch).toHaveBeenCalledTimes(3);
        expect(String(io.fetch.mock.calls[0][0])).toBe("http://localhost:3000/runs");
        expect(JSON.parse(io.fetch.mock.calls[0][1]!.body as string)).toEqual({
            datasetName: "retention", datasetVersion: 3, promptVersion: "v2",
        });
        expect(io.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
        expect(String(io.fetch.mock.calls[1][0])).toBe(`http://localhost:3000/runs/${runId}`);
        expect(JSON.parse(io.out.mock.calls[0][0])).toEqual(report());
        expect(io.out).toHaveBeenCalledTimes(1);
        expect(io.error.mock.calls[0][0]).toContain(runId);
    });

    it.each([
        ["run"], ["other"], [...args, "--unknown", "x"],
        [...args, "--dataset-version", "0"], [...args, "--prompt", "../v1"],
        [...args, "--poll-ms", "NaN"], [...args, "--timeout-ms", "0"],
        [...args, "--api-url", "file:///tmp"], [...args, "--api-url", "http://user:pass@localhost"],
    ])("rejects invalid arguments before creating a run: %j", async (...input) => {
        const io = harness();
        expect(await runCli(input, io)).toBe(2);
        expect(io.fetch).not.toHaveBeenCalled();
        expect(io.out).not.toHaveBeenCalled();
    });

    it("shows help without contacting the API", async () => {
        const io = harness();
        expect(await runCli(["--help"], io)).toBe(0);
        expect(io.out.mock.calls[0][0]).toContain("Usage: evalflow run");
        expect(io.fetch).not.toHaveBeenCalled();
    });

    it("keeps an API base path and reports a useful HTTP error", async () => {
        const io = harness();
        io.fetch.mockResolvedValue(Response.json({ error: "Dataset not found" }, { status: 404 }));
        expect(await runCli([...args, "--api-url", "http://localhost:3000/api"], io)).toBe(2);
        expect(String(io.fetch.mock.calls[0][0])).toBe("http://localhost:3000/api/runs");
        expect(io.error.mock.calls[0][0]).toBe("API 404: Dataset not found");
        expect(io.fetch).toHaveBeenCalledTimes(1);
    });

    it("does not resubmit after losing the creation response", async () => {
        const io = harness();
        io.fetch.mockRejectedValue(new Error("Connection lost"));
        expect(await runCli(args, io)).toBe(2);
        expect(io.fetch).toHaveBeenCalledTimes(1);
        expect(io.out).not.toHaveBeenCalled();
    });

    it("rejects malformed success responses and mismatched report IDs", async () => {
        for (const body of [{}, { ...report(), run: { id: "00000000-0000-4000-8000-000000000002" } }]) {
            const io = harness();
            io.fetch.mockResolvedValueOnce(created()).mockResolvedValueOnce(Response.json(body));
            expect(await runCli(args, io)).toBe(2);
            expect(io.out).not.toHaveBeenCalled();
        }
    });

    it("times out a stalled poll and retains the created run ID for recovery", async () => {
        const io = harness();
        io.fetch.mockResolvedValueOnce(created()).mockImplementationOnce((_url, init) => new Promise((_, reject) => {
            init!.signal!.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
        }));
        expect(await runCli([...args, "--timeout-ms", "20"], io)).toBe(2);
        expect(io.error.mock.calls.at(-1)![0]).toContain(`Timed out waiting for run ${runId}`);
        expect(io.error.mock.calls.at(-1)![0]).toContain("not cancelled");
        expect(io.out).not.toHaveBeenCalled();
        expect(io.fetch).toHaveBeenCalledTimes(2);
    });
});
