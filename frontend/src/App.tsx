import { useEffect, useState } from "react";
import type { SubmitEventHandler } from "react";
import {
    createJob,
    getJobDetails,
    getMetrics,
    listJobs,
    retryJob,
    type Job,
    type JobDetails,
    type Metrics,
} from "./api";

async function fetchDashboard() {
    const [jobs, metrics] = await Promise.all([listJobs(), getMetrics()]);

    return { jobs, metrics };
}

function App() {
    const [jobs, setJobs] = useState<Job[]>([]);
    const [metrics, setMetrics] = useState<Metrics | null>(null);
    const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
    const [jobDetails, setJobDetails] = useState<JobDetails | null>(null);
    const [userId, setUserId] = useState("user_123");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function refreshDashboard() {
        try {
            const { jobs: nextJobs, metrics: nextMetrics } =
                await fetchDashboard();

            setJobs(nextJobs);
            setMetrics(nextMetrics);
            setSelectedJobId((current) => current ?? nextJobs[0]?.id ?? null);
            setError(null);
        } catch (caught) {
            setError(errorMessage(caught));
        }
    }

    useEffect(() => {
        async function loadDashboard() {
            try {
                const { jobs: nextJobs, metrics: nextMetrics } =
                    await fetchDashboard();

                setJobs(nextJobs);
                setMetrics(nextMetrics);
                setSelectedJobId(
                    (current) => current ?? nextJobs[0]?.id ?? null,
                );
                setError(null);
            } catch (caught) {
                setError(errorMessage(caught));
            }
        }

        void loadDashboard();

        const interval = window.setInterval(() => {
            void loadDashboard();
        }, 2000);

        return () => window.clearInterval(interval);
    }, []);

    useEffect(() => {
        if (!selectedJobId) {
            return;
        }

        let cancelled = false;
        const jobId = selectedJobId;

        async function loadSelectedJob() {
            try {
                const details = await getJobDetails(jobId);

                if (!cancelled) {
                    setJobDetails(details);
                    setError(null);
                }
            } catch (caught) {
                if (!cancelled) {
                    setError(errorMessage(caught));
                }
            }
        }

        void loadSelectedJob();

        return () => {
            cancelled = true;
        };
    }, [selectedJobId, jobs]);

    const handleSubmit: SubmitEventHandler<HTMLFormElement> = async (event) => {
        event.preventDefault();

        if (!userId.trim()) return;

        setIsSubmitting(true);

        try {
            const job = await createJob(userId.trim());
            setSelectedJobId(job.id);
            await refreshDashboard();
        } catch (caught) {
            setError(errorMessage(caught));
        } finally {
            setIsSubmitting(false);
        }
    };

    async function handleRetry() {
        if (!jobDetails || jobDetails.job.status !== "failed") return;

        try {
            const job = await retryJob(jobDetails.job.id);
            setSelectedJobId(job.id);
            await refreshDashboard();
        } catch (caught) {
            setError(errorMessage(caught));
        }
    }

    const selectedJob =
        jobDetails?.job.id === selectedJobId
            ? jobDetails.job
            : (jobs.find((job) => job.id === selectedJobId) ?? null);

    return (
        <main className="min-h-screen bg-slate-100 px-5 py-8 text-slate-950">
            <div className="mx-auto max-w-7xl">
                <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                            AI agent orchestration
                        </p>
                        <h1 className="mt-1 text-3xl font-semibold">
                            EvalFlow
                        </h1>
                    </div>

                    <span className="w-fit rounded-full border border-slate-300 bg-white px-3 py-1 text-sm font-semibold text-slate-700">
                        Local MVP
                    </span>
                </header>

                {error ? (
                    <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-800">
                        {error}
                    </div>
                ) : null}

                <section
                    className="mb-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6"
                    aria-label="Metrics"
                >
                    <Metric label="Total jobs" value={metrics?.totalJobs} />
                    <Metric label="Completed" value={metrics?.completedJobs} />
                    <Metric label="Failed" value={metrics?.failedJobs} />
                    <Metric
                        label="Avg latency"
                        value={metrics?.averageLatencyMs}
                        suffix=" ms"
                    />
                    <Metric
                        label="Avg eval"
                        value={metrics?.averageEvalScore}
                    />
                    <Metric label="Total tokens" value={metrics?.totalTokens} />
                </section>

                <section
                    className="grid gap-4 xl:grid-cols-[360px_1fr]"
                    aria-label="Dashboard"
                >
                    <div className="grid gap-4">
                        <SubmitJobForm
                            userId={userId}
                            isSubmitting={isSubmitting}
                            onUserIdChange={setUserId}
                            onSubmit={handleSubmit}
                        />

                        <JobList
                            jobs={jobs}
                            selectedJobId={selectedJobId}
                            onSelectJob={setSelectedJobId}
                        />
                    </div>

                    <JobDetailPanel
                        details={jobDetails}
                        fallbackJob={selectedJob}
                        onRetry={handleRetry}
                    />
                </section>
            </div>
        </main>
    );
}

function SubmitJobForm(props: {
    userId: string;
    isSubmitting: boolean;
    onUserIdChange: (value: string) => void;
    onSubmit: SubmitEventHandler<HTMLFormElement>;
}) {
    return (
        <article className="rounded-lg border border-slate-200 bg-white p-5">
            <h2 className="text-base font-semibold">Submit Job</h2>
            <form className="mt-4 grid gap-3" onSubmit={props.onSubmit}>
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                    User ID
                    <input
                        className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                        value={props.userId}
                        onChange={(event) =>
                            props.onUserIdChange(event.target.value)
                        }
                        placeholder="user_123"
                    />
                </label>

                <button
                    type="submit"
                    disabled={props.isSubmitting}
                    className="rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                    {props.isSubmitting ? "Submitting..." : "Run analysis"}
                </button>
            </form>
        </article>
    );
}

function JobList(props: {
    jobs: Job[];
    selectedJobId: string | null;
    onSelectJob: (id: string) => void;
}) {
    return (
        <article className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">Jobs</h2>
                <span className="text-xs font-medium text-slate-500">
                    Polls every 2s
                </span>
            </div>

            <div className="grid max-h-130 gap-2 overflow-auto pr-1">
                {props.jobs.length === 0 ? (
                    <p className="text-sm text-slate-600">
                        No jobs have been submitted yet.
                    </p>
                ) : null}

                {props.jobs.map((job) => (
                    <button
                        key={job.id}
                        type="button"
                        onClick={() => props.onSelectJob(job.id)}
                        className={`rounded-md border p-3 text-left transition ${
                            job.id === props.selectedJobId
                                ? "border-blue-500 bg-blue-50"
                                : "border-slate-200 bg-white hover:bg-slate-50"
                        }`}
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-sm font-semibold text-slate-950">
                                    {job.type}
                                </p>
                                <p className="mt-1 font-mono text-xs text-slate-500">
                                    {job.id.slice(0, 8)}
                                </p>
                            </div>
                            <StatusBadge status={job.status} />
                        </div>
                    </button>
                ))}
            </div>
        </article>
    );
}

function JobDetailPanel(props: {
    details: JobDetails | null;
    fallbackJob: Job | null;
    onRetry: () => void;
}) {
    const job = props.details?.job ?? props.fallbackJob;

    return (
        <article className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="mb-4 flex items-start justify-between gap-3">
                <h2 className="text-base font-semibold">Run Details</h2>
                {job?.status === "failed" ? (
                    <button
                        type="button"
                        onClick={props.onRetry}
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                    >
                        Retry
                    </button>
                ) : null}
            </div>

            {!job ? (
                <p className="text-sm text-slate-600">
                    Select a job to inspect result JSON, traces, evals, latency,
                    tokens, and errors.
                </p>
            ) : (
                <div className="grid gap-5">
                    <section className="grid gap-4 md:grid-cols-3">
                        <Detail label="Status" value={job.status} />
                        <Detail
                            label="Attempts"
                            value={`${job.attempts}/${job.maxAttempts}`}
                        />
                        <Detail
                            label="Latency"
                            value={formatMetric(job.latencyMs, " ms")}
                        />
                        <Detail
                            label="Prompt tokens"
                            value={formatMetric(job.promptTokens)}
                        />
                        <Detail
                            label="Completion tokens"
                            value={formatMetric(job.completionTokens)}
                        />
                        <Detail
                            label="Eval score"
                            value={formatMetric(job.evalScore)}
                        />
                    </section>

                    {job.error ? (
                        <section>
                            <SectionLabel>Error</SectionLabel>
                            <pre className="mt-2 overflow-auto rounded-md bg-rose-950 p-4 text-xs leading-5 text-rose-50">
                                {job.error}
                            </pre>
                        </section>
                    ) : null}

                    <section>
                        <SectionLabel>Result JSON</SectionLabel>
                        <JsonBlock value={job.result} />
                    </section>

                    <section>
                        <SectionLabel>Evaluation</SectionLabel>
                        {props.details?.eval ? (
                            <JsonBlock value={props.details.eval} />
                        ) : (
                            <p className="mt-2 text-sm text-slate-600">
                                No eval row recorded yet.
                            </p>
                        )}
                    </section>

                    <section>
                        <SectionLabel>Traces</SectionLabel>
                        <div className="mt-2 grid gap-2">
                            {props.details?.traces.map((trace) => (
                                <details
                                    key={trace.id}
                                    className="rounded-md border border-slate-200 bg-slate-50 p-3"
                                >
                                    <summary className="cursor-pointer text-sm font-semibold text-slate-800">
                                        {trace.stepName}
                                        <span className="ml-2 text-xs font-normal text-slate-500">
                                            {formatMetric(
                                                trace.latencyMs,
                                                " ms",
                                            )}
                                        </span>
                                    </summary>
                                    <JsonBlock
                                        value={{
                                            input: trace.input,
                                            output: trace.output,
                                        }}
                                    />
                                </details>
                            ))}
                        </div>
                    </section>
                </div>
            )}
        </article>
    );
}

function Metric(props: {
    label: string;
    value: number | null | undefined;
    suffix?: string;
}) {
    return (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
                {props.label}
            </span>
            <strong className="mt-2 block text-2xl font-semibold text-slate-950">
                {formatMetric(props.value, props.suffix)}
            </strong>
        </div>
    );
}

function Detail(props: { label: string; value: string }) {
    return (
        <div>
            <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
                {props.label}
            </span>
            <p className="mt-1 text-sm font-medium text-slate-950">
                {props.value}
            </p>
        </div>
    );
}

function SectionLabel(props: { children: string }) {
    return (
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">
            {props.children}
        </h3>
    );
}

function StatusBadge(props: { status: Job["status"] }) {
    const classes = {
        queued: "bg-amber-50 text-amber-700",
        running: "bg-blue-50 text-blue-700",
        completed: "bg-emerald-50 text-emerald-700",
        failed: "bg-rose-50 text-rose-700",
    };

    return (
        <span
            className={`rounded-full px-2 py-1 text-xs font-bold ${classes[props.status]}`}
        >
            {props.status}
        </span>
    );
}

function JsonBlock(props: { value: unknown }) {
    return (
        <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-slate-950 p-4 text-xs leading-5 text-slate-100">
            {JSON.stringify(props.value, null, 2)}
        </pre>
    );
}

function formatMetric(value: number | null | undefined, suffix = "") {
    if (value === null || value === undefined) return "--";
    return `${Math.round(value).toLocaleString()}${suffix}`;
}

function errorMessage(caught: unknown) {
    return caught instanceof Error ? caught.message : String(caught);
}

export default App;
