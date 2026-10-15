const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export type JobStatus = "queued" | "running" | "completed" | "dead_letter";

export type Job = {
    id: string;
    type: string;
    status: JobStatus;
    input: unknown;
    result: unknown | null;
    error: string | null;
    attempts: number;
    maxAttempts: number;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    latencyMs: number | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    estimatedCost: string | null;
    evalScore: number | null;
};

export type Trace = {
    id: string;
    jobId: string;
    stepName: string;
    input: unknown;
    output: unknown;
    latencyMs: number | null;
    createdAt: string;
};

export type EvalResult = {
    id: string;
    jobId: string;
    validJson: boolean;
    hasRequiredFields: boolean;
    evidenceIncluded: boolean;
    evidenceSupported: boolean;
    reasonableRiskLabel: boolean;
    taskCompletionScore: number;
    notes: string | null;
    createdAt: string;
};

export type JobDetails = {
    job: Job;
    traces: Trace[];
    eval: EvalResult | null;
};

export type Metrics = {
    totalJobs: number;
    completedJobs: number;
    failedJobs: number;
    averageLatencyMs: number | null;
    averageEvalScore: number | null;
    totalTokens: number;
};

export type Dataset = { id: string; name: string; version: number; caseCount: number };

export type MockConfig = {
    seed: string;
    invalidJsonRate: number;
    wrongLabelRate: number;
    missingEvidenceRate: number;
    latencyMs: number;
};

export type Run = {
    id: string;
    datasetId: string;
    promptVersion: string;
    provider: string;
    model: string;
    mockConfig: Partial<MockConfig>;
    createdAt: string;
};

export type RunReport = {
    run: Run & { dataset: { name: string; version: number } };
    status: "in_progress" | "finished";
    jobs: { total: number; queued: number; running: number; completed: number; failed: number };
    passed: number;
    passRate: number;
    meanScore: number | null;
    latencyMs: { p50: number | null; p95: number | null };
    totalTokens: number;
    totalCost: number;
};

export type CaseChange = "regression" | "improvement" | "warning" | "unchanged" | "pending";
type RunSide = { outcome: "pass" | "fail" | "pending"; score: number | null };

export type RunComparison = {
    baseline: Run;
    candidate: Run;
    dataset: { name: string; version: number };
    cases: Array<{ caseId: string; caseName: string; baseline: RunSide; candidate: RunSide; change: CaseChange }>;
    summary: Record<CaseChange, number>;
};

export type CreateRunInput = {
    datasetName: string;
    datasetVersion: number;
    promptVersion: string;
    mockConfig?: MockConfig;
};

async function parseResponseError(response: Response, fallback: string) {
    const body = (await response.json().catch(() => null)) as {
        error?: unknown;
        message?: unknown;
    } | null;
    const detail = body?.message ?? body?.error;

    if (typeof detail === "string") return `${fallback}: ${detail}`;
    if (detail && typeof detail === "object" && "fieldErrors" in detail) {
        const errors = (detail as { fieldErrors: Record<string, string[]> }).fieldErrors;
        const fields = Object.entries(errors).map(([field, messages]) => `${field}: ${messages.join(", ")}`);
        return `${fallback}: ${fields.join("; ")}`;
    }
    return fallback;
}

async function runRequest<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${API_URL}${path}`, options);
    if (!response.ok) throw new Error(await parseResponseError(response, "Run request failed"));
    return response.json();
}

export function listDatasets(signal?: AbortSignal) {
    return runRequest<Dataset[]>("/datasets", { signal });
}

export function listRuns(signal?: AbortSignal) {
    return runRequest<RunReport[]>("/runs", { signal });
}

export function getRunReport(id: string, signal?: AbortSignal) {
    return runRequest<RunReport>(`/runs/${encodeURIComponent(id)}`, { signal });
}

export function compareRuns(baselineId: string, candidateId: string, signal?: AbortSignal) {
    return runRequest<RunComparison>(
        `/runs/${encodeURIComponent(baselineId)}/compare/${encodeURIComponent(candidateId)}`, { signal },
    );
}

export function createRun(input: CreateRunInput) {
    return runRequest<{ ok: true; run: Run; jobCount: number }>("/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
    });
}

export async function listJobs(status?: JobStatus, signal?: AbortSignal): Promise<Job[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : "";
    const response = await fetch(`${API_URL}/jobs${query}`, { signal });
    if (!response.ok) {
        throw new Error(await parseResponseError(response, "Failed to fetch jobs"));
    }
    return response.json();
}

export async function getJobDetails(id: string): Promise<JobDetails> {
    const response = await fetch(`${API_URL}/jobs/${id}`);
    if (!response.ok) {
        throw new Error(await parseResponseError(response, "Failed to fetch job details"));
    }
    return response.json();
}

export async function getMetrics(signal?: AbortSignal): Promise<Metrics> {
    const response = await fetch(`${API_URL}/metrics`, { signal });
    if (!response.ok) {
        throw new Error(await parseResponseError(response, "Failed to fetch metrics"));
    }
    return response.json();
}

export async function createJob(userId: string): Promise<Job> {
    const response = await fetch(`${API_URL}/jobs`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            type: "retention_risk_analysis",
            input: { userId },
        }),
    });

    if (!response.ok) {
        throw new Error(await parseResponseError(response, "Failed to create job"));
    }
    return response.json();
}

export async function retryJob(id: string): Promise<Job> {
    const response = await fetch(`${API_URL}/jobs/${id}/retry`, {
        method: "POST",
    });

    if (!response.ok) {
        throw new Error(await parseResponseError(response, "Failed to retry job"));
    }
    return response.json();
}
