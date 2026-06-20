const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export type JobStatus = "queued" | "running" | "completed" | "failed";

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

async function parseResponseError(response: Response, fallback: string) {
    try {
        const body = (await response.json()) as { error?: unknown; message?: unknown };
        const detail = body.message ?? body.error;

        if (typeof detail === "string") {
            return `${fallback}: ${detail}`;
        }
    } catch {
        // Fall back to the generic message below.
    }

    return fallback;
}

export async function listJobs(): Promise<Job[]> {
    const response = await fetch(`${API_URL}/jobs`);
    if (!response.ok) {
        throw new Error(await parseResponseError(response, "Failed to fetch jobs"));
    }
    return response.json();
}

export async function getJobDetails(id: string): Promise<JobDetails> {
    const response = await fetch(`${API_URL}/jobs/${id}`);
    if (!response.ok) {
        throw new Error(
            await parseResponseError(response, "Failed to fetch job details"),
        );
    }
    return response.json();
}

export async function getMetrics(): Promise<Metrics> {
    const response = await fetch(`${API_URL}/metrics`);
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
