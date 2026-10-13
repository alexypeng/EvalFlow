import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { CreateRunSchema } from "./types.js";

export const cliUsage = `Usage: evalflow run --dataset <name> [options]

  --dataset-version <number>  Dataset version (default: 1)
  --prompt <version>          Prompt version (default: v1)
  --api-url <url>             API address (default: http://localhost:3000)
  --poll-ms <number>          Wait between completed polls (default: 1000)
  --timeout-ms <number>       Total deadline including creation (default: 120000)
  --help, -h                 Show help

Prints the finished run report as JSON to stdout; progress goes to stderr.
Exit 0: report retrieved. Exit 2: input, API, or timeout error.
This scaffold does not yet compare baselines or decide regression exit codes.`;

const count = z.number().int().nonnegative();
const runSchema = z.object({ id: z.uuid() }).passthrough();
const createdSchema = z.object({ ok: z.literal(true), run: runSchema, jobCount: count });
const reportSchema = z.object({
    run: runSchema,
    status: z.enum(["in_progress", "finished"]),
    jobs: z.object({ total: count, queued: count, running: count, completed: count, failed: count }),
    passed: count,
    passRate: z.number().min(0).max(1),
    meanScore: z.number().min(0).max(100).nullable(),
    latencyMs: z.object({ p50: z.number().nonnegative().nullable(), p95: z.number().nonnegative().nullable() }),
    totalTokens: count,
    totalCost: z.number().nonnegative(),
}).passthrough().refine((report) =>
    report.jobs.total === report.jobs.queued + report.jobs.running + report.jobs.completed + report.jobs.failed
    && report.passed <= report.jobs.completed
    && (report.status === "finished") === (report.jobs.queued + report.jobs.running === 0),
    { message: "Inconsistent run progress" },
);

type CliIo = { out: (text: string) => void; error: (text: string) => void; fetch: typeof fetch };

export async function runCli(args: string[], io: CliIo = {
    out: (text) => console.log(text),
    error: (text) => console.error(text),
    fetch: globalThis.fetch,
}): Promise<number> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let signal: AbortSignal | undefined;
    let runId: string | undefined;
    try {
        const { values, positionals } = parseArgs({
            args,
            allowPositionals: true,
            options: {
                dataset: { type: "string" },
                "dataset-version": { type: "string", default: "1" },
                prompt: { type: "string", default: "v1" },
                "api-url": { type: "string", default: "http://localhost:3000" },
                "poll-ms": { type: "string", default: "1000" },
                "timeout-ms": { type: "string", default: "120000" },
                help: { type: "boolean", short: "h" },
            },
        });
        if (values.help) {
            io.out(cliUsage);
            return 0;
        }
        if (positionals.length !== 1 || positionals[0] !== "run") throw new Error(cliUsage);

        const input = CreateRunSchema.parse({
            datasetName: values.dataset,
            datasetVersion: Number(values["dataset-version"]),
            promptVersion: values.prompt,
        });
        const pollMs = z.coerce.number().int().min(1).max(60000).parse(values["poll-ms"]);
        const timeoutMs = z.coerce.number().int().min(1).max(3600000).parse(values["timeout-ms"]);
        const apiUrl = new URL(values["api-url"]!);
        if (!["http:", "https:"].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password) {
            throw new Error("API URL must be HTTP(S) without embedded credentials");
        }
        if (apiUrl.search || apiUrl.hash) throw new Error("API URL cannot contain a query or fragment");
        if (!apiUrl.pathname.endsWith("/")) apiUrl.pathname += "/";

        const controller = new AbortController();
        signal = controller.signal;
        deadline = setTimeout(() => controller.abort(), timeoutMs);

        async function request(path: string, init: RequestInit = {}) {
            const response = await io.fetch(new URL(path, apiUrl), { ...init, signal });
            if (!response.ok) {
                let detail = "";
                try {
                    const body = z.object({ error: z.string() }).safeParse(await response.json());
                    if (body.success) detail = `: ${body.data.error}`;
                } catch {
                    // Non-JSON error bodies still report their HTTP status.
                }
                throw new Error(`API ${response.status}${detail}`);
            }
            try {
                return await response.json() as unknown;
            } catch {
                throw new Error("API returned a non-JSON response");
            }
        }

        // Never retry creation automatically: a lost response may still have created a run.
        const created = createdSchema.parse(await request("runs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
        }));
        runId = created.run.id;
        io.error(`Created run ${runId}: ${created.jobCount} cases`);

        while (true) {
            const report = reportSchema.parse(await request(`runs/${runId}`));
            if (report.run.id !== runId) throw new Error("API returned a report for a different run");
            const { completed, failed, total } = report.jobs;
            io.error(`Run ${runId}: ${completed} completed, ${failed} failed, ${total} total`);
            if (report.status === "finished") {
                io.out(JSON.stringify(report, null, 2));
                return 0;
            }
            await sleep(pollMs, undefined, { signal });
        }
    } catch (error) {
        let message = error instanceof Error ? error.message : "Unknown CLI error";
        if (signal?.aborted) {
            const context = runId ? ` waiting for run ${runId}` : " creating the run";
            message = `Timed out${context}; server-side jobs are not cancelled`;
        } else if (error instanceof z.ZodError) {
            const issues = error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
            message = `Invalid input or API response: ${issues}`;
        }
        io.error(message);
        return 2;
    } finally {
        if (deadline) clearTimeout(deadline);
    }
}
