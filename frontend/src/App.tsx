import { useEffect, useState } from "react";
import type { SubmitEventHandler } from "react";
import { ChevronDown } from "lucide-react";
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
    const [showHistory, setShowHistory] = useState(false);
    const [showMetrics, setShowMetrics] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function refreshDashboard() {
        try {
            const { jobs: nextJobs, metrics: nextMetrics } =
                await fetchDashboard();

            setJobs(nextJobs);
            setMetrics(nextMetrics);
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
        if (!selectedJobId) return;

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
            setJobDetails(null);
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
    const hasSelectedRun = selectedJobId !== null;

    return (
        <main className="min-h-screen bg-slate-950 px-4 py-5 text-slate-950 sm:px-6 lg:px-8">
            <TopDropdowns
                jobs={jobs}
                metrics={metrics}
                selectedJobId={selectedJobId}
                showHistory={showHistory}
                showMetrics={showMetrics}
                onSelectJob={setSelectedJobId}
                onHistoryToggle={setShowHistory}
                onMetricsToggle={setShowMetrics}
            />

            <div
                className={`mx-auto transition-all duration-500 ${
                    hasSelectedRun
                        ? "max-w-6xl"
                        : "flex min-h-[calc(100vh-2.5rem)] max-w-3xl items-center"
                }`}
            >
                <div className="relative w-full">
                    <header
                        className={`text-center transition-all duration-500 ${
                            hasSelectedRun ? "mb-5 sm:text-left" : "mb-8"
                        }`}
                    >
                        <p className="text-xs font-bold uppercase tracking-wide text-cyan-300">
                            AI Platform Infrastructure
                        </p>
                        <h1
                            className={`mt-2 font-semibold text-white transition-all duration-500 ${
                                hasSelectedRun
                                    ? "text-3xl"
                                    : "text-5xl sm:text-6xl"
                            }`}
                        >
                            EvalFlow
                        </h1>
                        <p
                            className={`mx-auto mt-3 text-sm leading-6 text-slate-300 ${
                                hasSelectedRun
                                    ? "max-w-2xl sm:mx-0"
                                    : "max-w-xl"
                            }`}
                        >
                            Run retention risk analysis through a local AI agent
                            pipeline with async jobs, tool calls, structured
                            validation, eval scoring, traces, latency, and
                            token tracking.
                        </p>
                    </header>

                    {error ? (
                        <div className="mb-4 rounded-xl border border-rose-400/30 bg-rose-400/10 px-4 py-3 text-sm font-medium text-rose-100">
                            {error}
                        </div>
                    ) : null}

                    <SubmitJobForm
                        userId={userId}
                        isSubmitting={isSubmitting}
                        compact={hasSelectedRun}
                        onUserIdChange={setUserId}
                        onSubmit={handleSubmit}
                    />

                    {hasSelectedRun ? (
                        <section className="mt-5 grid gap-4" aria-label="Run">
                            <JobDetailPanel
                                details={jobDetails}
                                fallbackJob={selectedJob}
                                onRetry={handleRetry}
                            />
                        </section>
                    ) : null}
                </div>
            </div>
        </main>
    );
}

function TopDropdowns(props: {
    jobs: Job[];
    metrics: Metrics | null;
    selectedJobId: string | null;
    showHistory: boolean;
    showMetrics: boolean;
    onSelectJob: (id: string) => void;
    onHistoryToggle: (open: boolean) => void;
    onMetricsToggle: (open: boolean) => void;
}) {
    return (
        <div className="fixed right-4 top-4 z-50 flex max-w-[calc(100vw-2rem)] items-start justify-end gap-2 sm:right-6">
            <div
                className={`overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl shadow-slate-950/50 transition-all duration-200 ease-out ${
                    props.showHistory
                        ? "w-[22rem] max-w-[calc(100vw-2rem)]"
                        : "w-[6.25rem]"
                }`}
            >
                <button
                    type="button"
                    onClick={() => props.onHistoryToggle(!props.showHistory)}
                    className="flex h-8 w-full items-center justify-between gap-2 px-3 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
                    aria-expanded={props.showHistory}
                >
                    <span>History</span>
                    <DropdownArrow open={props.showHistory} />
                </button>

                <div
                    className={`grid transition-all duration-200 ease-out ${
                        props.showHistory
                            ? "grid-rows-[1fr] opacity-100"
                            : "grid-rows-[0fr] opacity-0"
                    }`}
                >
                    <div
                        className={`min-h-0 overflow-hidden ${
                            props.showHistory ? "px-3 pb-3" : "px-0 pb-0"
                        }`}
                    >
                        <JobList
                            jobs={props.jobs}
                            selectedJobId={props.selectedJobId}
                            onSelectJob={props.onSelectJob}
                        />
                    </div>
                </div>
            </div>

            <div
                className={`overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 shadow-2xl shadow-slate-950/50 transition-all duration-200 ease-out ${
                    props.showMetrics ? "w-64" : "w-[6.5rem]"
                }`}
            >
                <button
                    type="button"
                    onClick={() => props.onMetricsToggle(!props.showMetrics)}
                    className="flex h-8 w-full items-center justify-between gap-2 px-3 text-xs font-semibold text-slate-200 transition hover:bg-slate-800"
                    aria-expanded={props.showMetrics}
                >
                    <span>Metrics</span>
                    <DropdownArrow open={props.showMetrics} />
                </button>

                <div
                    className={`grid transition-all duration-200 ease-out ${
                        props.showMetrics
                            ? "grid-rows-[1fr] opacity-100"
                            : "grid-rows-[0fr] opacity-0"
                    }`}
                >
                    <section
                        className={`grid min-h-0 gap-2 overflow-hidden ${
                            props.showMetrics ? "px-3 pb-3" : "px-0 pb-0"
                        }`}
                        aria-label="Metrics"
                    >
                    <Metric label="Total jobs" value={props.metrics?.totalJobs} />
                    <Metric
                        label="Completed"
                        value={props.metrics?.completedJobs}
                    />
                    <Metric label="Failed" value={props.metrics?.failedJobs} />
                    <Metric
                        label="Avg latency"
                        value={props.metrics?.averageLatencyMs}
                        suffix=" ms"
                    />
                    <Metric
                        label="Avg eval"
                        value={props.metrics?.averageEvalScore}
                    />
                    <Metric
                        label="Total tokens"
                        value={props.metrics?.totalTokens}
                    />
                    </section>
                </div>
            </div>
        </div>
    );
}

function DropdownArrow(props: { open: boolean }) {
    return (
        <ChevronDown
            aria-hidden="true"
            size={14}
            strokeWidth={2.25}
            className={`text-slate-400 transition-transform duration-200 ${
                props.open ? "rotate-180" : ""
            }`}
        />
    );
}

function SubmitJobForm(props: {
    userId: string;
    isSubmitting: boolean;
    compact: boolean;
    onUserIdChange: (value: string) => void;
    onSubmit: SubmitEventHandler<HTMLFormElement>;
}) {
    return (
        <article
            className={`rounded-2xl border border-slate-700 bg-slate-900 p-3 shadow-2xl shadow-cyan-950/30 transition-all duration-500 ${
                props.compact ? "max-w-3xl" : "mx-auto max-w-2xl"
            }`}
        >
            <form
                className={`flex gap-2 ${
                    props.compact
                        ? "flex-col sm:flex-row"
                        : "flex-col sm:flex-row"
                }`}
                onSubmit={props.onSubmit}
            >
                <label className="sr-only" htmlFor="user-id">
                    User ID
                </label>
                <div className="flex min-w-0 flex-1 items-center rounded-xl border border-slate-700 bg-slate-950 px-4 focus-within:border-cyan-400 focus-within:ring-4 focus-within:ring-cyan-400/10">
                    <input
                        id="user-id"
                        className="h-12 w-full bg-transparent text-base text-white outline-none placeholder:text-slate-500"
                        value={props.userId}
                        onChange={(event) =>
                            props.onUserIdChange(event.target.value)
                        }
                        placeholder="Enter user ID, e.g. user_123"
                    />
                </div>

                <button
                    type="submit"
                    disabled={props.isSubmitting}
                    className="h-12 rounded-xl bg-cyan-400 px-6 text-sm font-bold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-300"
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
        <article className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold text-white">Jobs</h2>
                    <p className="mt-1 text-xs text-slate-400">
                        Latest runs from Postgres
                    </p>
                </div>
                <span className="rounded-full bg-slate-800 px-2 py-1 text-xs font-medium text-slate-300">
                    {props.jobs.length} total
                </span>
            </div>

            <div className="grid max-h-[32rem] gap-2 overflow-auto pr-1">
                {props.jobs.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-slate-700 bg-slate-950 p-4 text-sm text-slate-400">
                        No jobs yet. Enter a user ID and run an analysis.
                    </div>
                ) : null}

                {props.jobs.map((job) => (
                    <button
                        key={job.id}
                        type="button"
                        onClick={() => props.onSelectJob(job.id)}
                        className={`rounded-lg border p-3 text-left transition ${
                            job.id === props.selectedJobId
                                ? "border-cyan-400 bg-cyan-400/10 shadow-sm ring-2 ring-cyan-400/10"
                                : "border-slate-800 bg-slate-950 hover:border-slate-700 hover:bg-slate-900"
                        }`}
                    >
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-sm font-semibold text-white">
                                    {job.type}
                                </p>
                                <p className="mt-1 font-mono text-xs text-slate-400">
                                    {job.id.slice(0, 8)}
                                </p>
                            </div>
                            <StatusBadge status={job.status} />
                        </div>
                        <div className="mt-3 flex items-center justify-between text-xs text-slate-400">
                            <span>
                                Attempts {job.attempts}/{job.maxAttempts}
                            </span>
                            <span>{formatMetric(job.evalScore)} eval</span>
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
        <article className="min-h-[720px] rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-sm">
            <div className="mb-5 flex flex-col gap-3 border-b border-slate-800 pb-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                    <h2 className="text-base font-semibold text-white">
                        Run Details
                    </h2>
                    <p className="mt-1 text-sm text-slate-400">
                        Structured output, traces, evals, latency, tokens, and
                        errors for the selected job.
                    </p>
                </div>
                {job?.status === "failed" ? (
                    <button
                        type="button"
                        onClick={props.onRetry}
                        className="w-fit rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:bg-slate-800"
                    >
                        Retry
                    </button>
                ) : null}
            </div>

            {!job ? (
                <div className="flex min-h-96 items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-950 p-8 text-center">
                    <div>
                        <h3 className="text-sm font-semibold text-white">
                            No run selected
                        </h3>
                        <p className="mt-2 max-w-sm text-sm leading-6 text-slate-400">
                            Submit a job or select an existing run to inspect
                            the agent workflow.
                        </p>
                    </div>
                </div>
            ) : (
                <div className="grid gap-6">
                    <section className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
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
                            label="Prompt"
                            value={formatMetric(job.promptTokens)}
                        />
                        <Detail
                            label="Completion"
                            value={formatMetric(job.completionTokens)}
                        />
                        <Detail
                            label="Eval"
                            value={formatMetric(job.evalScore)}
                        />
                    </section>

                    {job.error ? (
                        <section>
                            <SectionLabel>Error</SectionLabel>
                            <pre className="mt-2 overflow-auto rounded-lg bg-rose-950 p-4 text-xs leading-5 text-rose-50">
                                {job.error}
                            </pre>
                        </section>
                    ) : null}

                    <section>
                        <SectionLabel>Analysis</SectionLabel>
                        <RetentionSummary value={job.result} />
                    </section>

                    <section>
                        <SectionLabel>Evaluation</SectionLabel>
                        {props.details?.eval ? (
                            <EvalSummary value={props.details.eval} />
                        ) : (
                            <p className="mt-2 rounded-lg border border-dashed border-slate-700 bg-slate-950 p-4 text-sm text-slate-400">
                                No eval row recorded yet.
                            </p>
                        )}
                        <JsonDisclosure label="Result JSON" value={job.result} />
                    </section>

                    <section>
                        <SectionLabel>Traces</SectionLabel>
                        <div className="mt-2 grid gap-2">
                            {props.details?.traces.map((trace, index) => (
                                <details
                                    key={trace.id}
                                    className="rounded-lg border border-slate-800 bg-slate-950 p-3"
                                >
                                    <summary className="cursor-pointer text-sm font-semibold text-slate-200">
                                        <span className="mr-2 inline-flex size-6 items-center justify-center rounded-full bg-slate-900 text-xs text-slate-400 ring-1 ring-slate-700">
                                            {index + 1}
                                        </span>
                                        {trace.stepName}
                                        <span className="ml-2 text-xs font-normal text-slate-400">
                                            {formatMetric(
                                                trace.latencyMs,
                                                " ms",
                                            )}
                                        </span>
                                    </summary>
                                    <JsonDisclosure
                                        label="Trace payload"
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
        <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 shadow-sm">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-400">
                {props.label}
            </span>
            <strong className="mt-2 block text-2xl font-semibold text-white">
                {formatMetric(props.value, props.suffix)}
            </strong>
        </div>
    );
}

function RetentionSummary(props: { value: unknown }) {
    if (!isRetentionResult(props.value)) {
        return (
            <p className="mt-2 rounded-lg border border-dashed border-slate-700 bg-slate-950 p-4 text-sm text-slate-400">
                No structured retention result has been recorded yet.
            </p>
        );
    }

    return (
        <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="flex flex-wrap items-center gap-2">
                <RiskBadge risk={props.value.retentionRisk} />
                <span className="text-sm font-semibold capitalize text-white">
                    {props.value.retentionRisk} retention risk
                </span>
            </div>
            <p className="mt-3 text-sm leading-6 text-slate-300">
                {props.value.summary}
            </p>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                    <h4 className="text-xs font-bold uppercase tracking-wide text-slate-400">
                        Evidence
                    </h4>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-300">
                        {props.value.evidence.map((item) => (
                            <li key={item}>{item}</li>
                        ))}
                    </ul>
                </div>

                <div>
                    <h4 className="text-xs font-bold uppercase tracking-wide text-slate-400">
                        Recommended actions
                    </h4>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-300">
                        {props.value.recommendedActions.map((item) => (
                            <li key={item}>{item}</li>
                        ))}
                    </ul>
                </div>
            </div>
        </div>
    );
}

function EvalSummary(props: { value: NonNullable<JobDetails["eval"]> }) {
    const checks = [
        ["Valid JSON", props.value.validJson],
        ["Required fields", props.value.hasRequiredFields],
        ["Evidence included", props.value.evidenceIncluded],
        ["Evidence supported", props.value.evidenceSupported],
        ["Reasonable risk label", props.value.reasonableRiskLabel],
    ] as const;

    return (
        <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950 p-4">
            <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-white">
                    Score: {props.value.taskCompletionScore}/100
                </span>
                <span className="text-xs text-slate-400">
                    {new Date(props.value.createdAt).toLocaleString()}
                </span>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
                {checks.map(([label, passed]) => (
                    <span
                        key={label}
                        className={`rounded-full px-2 py-1 text-xs font-semibold ${
                            passed
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-rose-50 text-rose-700"
                        }`}
                    >
                        {passed ? "Pass" : "Fail"}: {label}
                    </span>
                ))}
            </div>
            {props.value.notes ? (
                <p className="mt-3 text-sm leading-6 text-slate-300">
                    {props.value.notes}
                </p>
            ) : null}
        </div>
    );
}

function Detail(props: { label: string; value: string }) {
    return (
        <div className="rounded-lg border border-slate-800 bg-slate-950 p-3">
            <span className="text-xs font-bold uppercase tracking-wide text-slate-400">
                {props.label}
            </span>
            <p className="mt-1 text-sm font-semibold text-white">
                {props.value}
            </p>
        </div>
    );
}

function SectionLabel(props: { children: string }) {
    return (
        <h3 className="text-xs font-bold uppercase tracking-wide text-slate-400">
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

function RiskBadge(props: { risk: RetentionResult["retentionRisk"] }) {
    const classes = {
        low: "bg-emerald-50 text-emerald-700",
        medium: "bg-amber-50 text-amber-700",
        high: "bg-rose-50 text-rose-700",
    };

    return (
        <span
            className={`rounded-full px-2 py-1 text-xs font-bold ${classes[props.risk]}`}
        >
            {props.risk}
        </span>
    );
}

function JsonBlock(props: { value: unknown }) {
    return (
        <pre className="mt-2 max-h-96 overflow-auto rounded-lg bg-slate-950 p-4 text-xs leading-5 text-slate-100">
            {JSON.stringify(props.value, null, 2)}
        </pre>
    );
}

function JsonDisclosure(props: { label: string; value: unknown }) {
    return (
        <details className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
            <summary className="cursor-pointer text-sm font-semibold text-slate-200">
                {props.label}
            </summary>
            <JsonBlock value={props.value} />
        </details>
    );
}

type RetentionResult = {
    summary: string;
    retentionRisk: "low" | "medium" | "high";
    evidence: string[];
    recommendedActions: string[];
};

function isRetentionResult(value: unknown): value is RetentionResult {
    if (!value || typeof value !== "object") return false;

    const candidate = value as Partial<RetentionResult>;

    return (
        typeof candidate.summary === "string" &&
        (candidate.retentionRisk === "low" ||
            candidate.retentionRisk === "medium" ||
            candidate.retentionRisk === "high") &&
        Array.isArray(candidate.evidence) &&
        candidate.evidence.every((item) => typeof item === "string") &&
        Array.isArray(candidate.recommendedActions) &&
        candidate.recommendedActions.every((item) => typeof item === "string")
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
