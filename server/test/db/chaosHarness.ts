import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

function launch(role: "worker" | "reaper", slot: number, generation: number) {
    const child = spawn(process.execPath, ["--import", "tsx", `src/${role}.ts`], {
        cwd: process.cwd(),
        env: {
            ...process.env, LLM_PROVIDER: "mock", GEMINI_API_KEY: "", RATE_LIMIT_MOCK: "true",
            WORKER_CONCURRENCY: "1", POLL_INTERVAL_MS: "20", LEASE_DURATION_MS: "1500",
            HEARTBEAT_INTERVAL_MS: "150", REAPER_INTERVAL_MS: "100", REAPER_BATCH_SIZE: "100",
            WORKER_SHUTDOWN_TIMEOUT_MS: "500", WORKER_SHUTDOWN_CLEANUP_MS: "500",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const record = {
        child, role, slot, generation, workerId: undefined as string | undefined,
        logs: "", expectedExit: false, spawnError: undefined as Error | undefined,
        completions: [] as string[],
        closed: new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            child.once("close", (code, signal) => resolve({ code, signal }));
        }),
    };
    let remainder = "";
    child.stdout.on("data", (data) => {
        const chunk = data.toString();
        record.logs = (record.logs + chunk).slice(-8000);
        const lines = (remainder + chunk).split("\n");
        remainder = lines.pop()!;
        for (const line of lines) {
            record.workerId ??= line.match(/^Worker ([0-9a-f-]{36}) running/)?.[1];
            const completed = line.match(/^Completed job ([0-9a-f-]{36})$/)?.[1];
            if (completed) record.completions.push(completed);
        }
    });
    child.stderr.on("data", (data) => { record.logs = (record.logs + data.toString()).slice(-8000); });
    child.on("error", (error) => { record.spawnError = error; });
    return record;
}

export class ChaosHarness {
    readonly processes: ReturnType<typeof launch>[] = [];
    readonly workers = new Map<number, ReturnType<typeof launch>>();
    private readonly deadline: number;

    constructor(timeoutMs = 75_000) {
        // Expire inside the test body so finally can clean up before Vitest's outer timeout.
        this.deadline = performance.now() + timeoutMs;
    }

    startWorker(slot: number) {
        const generation = (this.workers.get(slot)?.generation ?? -1) + 1;
        const worker = launch("worker", slot, generation);
        this.processes.push(worker);
        this.workers.set(slot, worker);
        return worker;
    }

    startReaper() {
        const reaper = launch("reaper", -1, 0);
        this.processes.push(reaper);
        return reaper;
    }

    async until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
        const deadline = Math.min(this.deadline, performance.now() + timeoutMs);
        while (true) {
            for (const process of this.processes) {
                if (process.spawnError) throw process.spawnError;
                if (!process.expectedExit && (process.child.exitCode !== null || process.child.signalCode !== null)) {
                    throw new Error(`${process.role} slot ${process.slot} exited unexpectedly: ${process.logs}`);
                }
            }
            if (await predicate()) return;
            if (performance.now() >= deadline) throw new Error("Chaos phase timed out");
            await sleep(25);
        }
    }

    async crash(slot: number) {
        const worker = this.workers.get(slot)!;
        worker.expectedExit = true;
        if (!worker.child.kill("SIGKILL")) throw new Error(`Could not kill owned worker slot ${slot}`);
        const timeout = setTimeout(() => worker.child.kill("SIGKILL"), 2000);
        try { return await worker.closed; } finally { clearTimeout(timeout); }
    }

    async stop() {
        await Promise.all(this.processes.map(async (process) => {
            process.expectedExit = true;
            if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill("SIGTERM");
            const timeout = setTimeout(() => process.child.kill("SIGKILL"), 2000);
            try { await process.closed; } finally { clearTimeout(timeout); }
        }));
    }

    diagnostics() {
        return this.processes.map((process) => ({
            role: process.role, slot: process.slot, generation: process.generation,
            pid: process.child.pid, workerId: process.workerId,
            exitCode: process.child.exitCode, signal: process.child.signalCode, logs: process.logs,
        }));
    }
}
