import { useEffect, useState } from "react";
import type { SubmitEventHandler } from "react";
import {
    compareRuns, createRun, getRunReport, listDatasets, listRuns,
    type CaseChange, type Dataset, type MockConfig, type Run, type RunComparison, type RunReport,
} from "./api";

const emptyConfig: MockConfig = {
    seed: "evalflow", wrongLabelRate: 0, invalidJsonRate: 0, missingEvidenceRate: 0, latencyMs: 0,
};

export default function RunsDashboard() {
    const [datasets, setDatasets] = useState<Dataset[]>([]);
    const [runs, setRuns] = useState<RunReport[]>([]);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [datasetId, setDatasetId] = useState("");
    const [promptVersion, setPromptVersion] = useState("v1");
    const [useMockConfig, setUseMockConfig] = useState(false);
    const [mockConfig, setMockConfig] = useState<MockConfig>(emptyConfig);
    const [submitting, setSubmitting] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [selectedRunId, setSelectedRunId] = useState("");
    const [baselineId, setBaselineId] = useState("");
    const [candidateId, setCandidateId] = useState("");
    const [revision, setRevision] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        let timeout: number;
        async function refresh() {
            try {
                const [nextDatasets, nextRuns] = await Promise.all([
                    listDatasets(controller.signal), listRuns(controller.signal),
                ]);
                if (controller.signal.aborted) return;
                setDatasets(nextDatasets);
                setRuns(nextRuns);
                setLoadError(null);
            } catch (error) {
                if (!controller.signal.aborted) setLoadError(message(error));
            } finally {
                if (!controller.signal.aborted) {
                    setLoading(false);
                    // Schedule after completion so a slow API cannot accumulate overlapping polls.
                    timeout = window.setTimeout(() => void refresh(), 2000);
                }
            }
        }
        void refresh();
        return () => { controller.abort(); window.clearTimeout(timeout); };
    }, [revision]);

    const dataset = datasets.find((item) => item.id === datasetId) ?? datasets[0];
    const baseline = runs.find((report) => report.run.id === baselineId);
    const candidates = baseline
        ? runs.filter((report) => report.run.datasetId === baseline.run.datasetId && report.run.id !== baselineId)
        : [];

    const submit: SubmitEventHandler<HTMLFormElement> = async (event) => {
        event.preventDefault();
        if (!dataset || submitting) return;
        setSubmitting(true);
        setActionError(null);
        setNotice(null);
        try {
            const result = await createRun({
                datasetName: dataset.name,
                datasetVersion: dataset.version,
                promptVersion,
                ...(useMockConfig ? { mockConfig } : {}),
            });
            setSelectedRunId(result.run.id);
            setNotice(`Created run ${result.run.id.slice(0, 8)} with ${result.jobCount} queued cases.`);
            setRevision((value) => value + 1);
        } catch (error) {
            setActionError(message(error));
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <main className="runs-dashboard">
            <header className="run-heading">
                <div>
                    <p className="run-eyebrow">Dataset evaluations</p>
                    <h1>Run, measure, compare.</h1>
                    <p>Evaluate every case, then compare a candidate against a reference run.</p>
                </div>
                <button type="button" className="run-secondary" onClick={() => setRevision((value) => value + 1)}>
                    Refresh
                </button>
            </header>

            {loadError && <p className="run-error" role="alert">{loadError} Previous results may be out of date.</p>}
            {actionError && <p className="run-error" role="alert">{actionError}</p>}
            {notice && <p className="run-notice" role="status">{notice}</p>}

            <section className="run-panel" aria-labelledby="create-run-heading">
                <h2 id="create-run-heading">Start a dataset run</h2>
                {loading ? <p className="run-muted">Loading datasets…</p> : datasets.length === 0 ? (
                    <p className="run-muted">No datasets loaded yet. Load a dataset to start evaluating cases.</p>
                ) : null}
                <form onSubmit={submit}>
                    <fieldset disabled={submitting || !dataset}>
                        <div className="run-form-grid">
                            <label>
                                Dataset
                                <select className="run-input" value={dataset?.id ?? ""}
                                    onChange={(event) => setDatasetId(event.target.value)} required>
                                    {!dataset && <option value="">No datasets available</option>}
                                    {datasets.map((item) => (
                                        <option key={item.id} value={item.id}>
                                            {item.name} v{item.version} · {item.caseCount} cases
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label>
                                Prompt version
                                <input className="run-input" value={promptVersion} required pattern="v[0-9]+"
                                    title="Use a version such as v1 or v2" maxLength={50}
                                    onChange={(event) => setPromptVersion(event.target.value)} />
                            </label>
                            <button className="run-button" type="submit">
                                {submitting ? "Creating run…" : "Start run"}
                            </button>
                        </div>
                        <label className="run-check">
                            <input type="checkbox" checked={useMockConfig}
                                onChange={(event) => setUseMockConfig(event.target.checked)} />
                            Configure mock failures and latency
                        </label>
                        {useMockConfig && (
                            <div className="run-mock-settings">
                                <p className="run-muted">
                                    For the mock provider. Rates are 0–1: 0.25 selects roughly 25% of cases.
                                    The same seed and case IDs select the same failures on retries.
                                </p>
                                <div className="run-settings-grid">
                                    <label>
                                        Seed
                                        <input className="run-input" value={mockConfig.seed} required maxLength={100}
                                            onChange={(event) => setMockConfig({
                                                ...mockConfig, seed: event.target.value,
                                            })} />
                                    </label>
                                    {([
                                        ["wrongLabelRate", "Changed label rate"],
                                        ["invalidJsonRate", "Invalid JSON rate"],
                                        ["missingEvidenceRate", "Missing evidence rate"],
                                        ["latencyMs", "Added latency (ms)"],
                                    ] as const).map(([field, label]) => (
                                        <label key={field}>
                                            {label}
                                            <input className="run-input" type="number" required min={0}
                                                max={field === "latencyMs" ? 60_000 : 1}
                                                step={field === "latencyMs" ? 1 : "any"}
                                                value={Number.isNaN(mockConfig[field]) ? "" : mockConfig[field]}
                                                onChange={(event) => setMockConfig({
                                                    ...mockConfig, [field]: event.target.valueAsNumber,
                                                })} />
                                        </label>
                                    ))}
                                </div>
                                <p className="run-muted">
                                    Invalid JSON and missing evidence retry, then become dead letters. Changed labels reach evaluation.
                                    These settings simulate failures; prompt versions alone do not change mock predictions.
                                </p>
                            </div>
                        )}
                    </fieldset>
                </form>
            </section>

            <section className="run-panel" aria-labelledby="recent-runs-heading">
                <div className="run-section-heading">
                    <h2 id="recent-runs-heading">Recent runs</h2>
                    <span className="run-muted">Latest 50 · refreshes every 2 seconds</span>
                </div>
                {loading ? <p className="run-muted">Loading runs…</p> : runs.length === 0 ? (
                    <p className="run-empty">No runs yet. Start a dataset run above.</p>
                ) : (
                    <div className="run-table-scroll" tabIndex={0} role="region" aria-label="Recent runs table">
                        <table className="run-table">
                            <thead><tr>
                                <th scope="col">Run / dataset</th><th scope="col">Prompt / provider</th>
                                <th scope="col">Progress</th><th scope="col">Pass rate</th>
                                <th scope="col">Mean score</th><th scope="col">Actions</th>
                            </tr></thead>
                            <tbody>{runs.map((report) => (
                                <tr key={report.run.id} className={report.run.id === selectedRunId ? "run-selected" : ""}>
                                    <td>
                                        <button type="button" className="run-link" title={report.run.id}
                                            onClick={() => setSelectedRunId(report.run.id)}>
                                            {report.run.id.slice(0, 8)}
                                        </button>
                                        <span className="run-cell-detail">
                                            {report.run.dataset.name} v{report.run.dataset.version}
                                        </span>
                                        <time className="run-cell-detail" dateTime={report.run.createdAt}>
                                            {new Date(report.run.createdAt).toLocaleString()}
                                        </time>
                                    </td>
                                    <td>{report.run.promptVersion}
                                        <span className="run-cell-detail">{report.run.provider}</span>
                                    </td>
                                    <td>
                                        <Badge value={report.status} />
                                        <span className="run-cell-detail">
                                            {report.jobs.completed + report.jobs.failed}/{report.jobs.total} finished
                                            {report.jobs.failed > 0 ? ` · ${report.jobs.failed} failed` : ""}
                                        </span>
                                    </td>
                                    <td>{percent(report.passRate)}<span className="run-cell-detail">
                                        {report.passed}/{report.jobs.total} passed
                                    </span></td>
                                    <td>{number(report.meanScore)}</td>
                                    <td><button className="run-secondary" type="button"
                                        aria-pressed={baselineId === report.run.id} onClick={() => {
                                        setBaselineId(report.run.id); setCandidateId("");
                                    }}>Use as baseline</button></td>
                                </tr>
                            ))}</tbody>
                        </table>
                    </div>
                )}
                <p className="run-muted">Pass rate includes all cases. Unfinished cases have not passed yet.</p>
            </section>

            {selectedRunId && <SelectedRun key={selectedRunId} id={selectedRunId} onClose={() => setSelectedRunId("")} />}

            <section className="run-panel" aria-labelledby="comparison-heading">
                <h2 id="comparison-heading">Compare runs</h2>
                <p className="run-muted">Baseline is the reference. Candidate is the new run you want to assess.</p>
                <div className="run-form-grid">
                    <label>
                        Baseline
                        <select className="run-input" value={baselineId} onChange={(event) => {
                            setBaselineId(event.target.value); setCandidateId("");
                        }}>
                            <option value="">Choose a reference run</option>
                            {runs.map((report) => <option key={report.run.id} value={report.run.id}>
                                {runLabel(report)}
                            </option>)}
                        </select>
                    </label>
                    <label>
                        Candidate
                        <select className="run-input" value={candidateId} disabled={!baseline}
                            onChange={(event) => setCandidateId(event.target.value)}>
                            <option value="">Choose a run of the same dataset</option>
                            {candidates.map((report) => <option key={report.run.id} value={report.run.id}>
                                {runLabel(report)}
                            </option>)}
                        </select>
                    </label>
                </div>
                {baselineId && candidateId ? (
                    <Comparison key={`${baselineId}:${candidateId}`} baselineId={baselineId} candidateId={candidateId} />
                ) : <p className="run-empty">Select two runs of the same dataset version to compare their cases.</p>}
            </section>
        </main>
    );
}

function SelectedRun({ id, onClose }: { id: string; onClose: () => void }) {
    const [report, setReport] = useState<RunReport | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        const controller = new AbortController();
        let timeout: number;
        async function refresh() {
            try {
                const value = await getRunReport(id, controller.signal);
                if (controller.signal.aborted) return;
                setReport(value);
                setError(null);
            } catch (error) {
                if (!controller.signal.aborted) setError(message(error));
            } finally {
                if (!controller.signal.aborted) timeout = window.setTimeout(() => void refresh(), 2000);
            }
        }
        void refresh();
        return () => { controller.abort(); window.clearTimeout(timeout); };
    }, [id]);
    // Ignore the previous selection while the new request is loading.
    const current = report?.run.id === id ? report : null;
    return (
        <section className="run-panel" aria-label="Selected run details">
            <div className="run-section-heading">
                <h2>Run {id.slice(0, 8)}</h2>
                <button type="button" className="run-secondary" onClick={onClose}>Close details</button>
            </div>
            {error && <p className="run-error" role="alert">{error}</p>}
            {!current ? <p className="run-muted">Loading run details…</p> : <>
                <p className="run-muted">
                    {current.run.dataset.name} v{current.run.dataset.version} · {current.run.promptVersion}
                    {" · "}{current.run.provider} / {current.run.model}
                </p>
                <div className="run-metrics-grid">
                    <Stat label="Pass rate" value={percent(current.passRate)} />
                    <Stat label="Mean score" value={number(current.meanScore)} />
                    <Stat label="p50 latency" value={number(current.latencyMs.p50, " ms")} />
                    <Stat label="p95 latency" value={number(current.latencyMs.p95, " ms")} />
                    <Stat label="Total tokens" value={number(current.totalTokens)} />
                    <Stat label="Cost" value={`$${current.totalCost.toFixed(6)}`} />
                </div>
                <p className="run-muted">
                    {current.jobs.queued} queued · {current.jobs.running} running · {current.jobs.completed} completed
                    {" · "}{current.jobs.failed} failed
                </p>
                <p className="run-muted">Score, latency, tokens and cost summarize completed jobs.</p>
                <ConfigSummary run={current.run} />
            </>}
        </section>
    );
}

function Comparison({ baselineId, candidateId }: { baselineId: string; candidateId: string }) {
    const [comparison, setComparison] = useState<RunComparison | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [filter, setFilter] = useState<CaseChange | "all">("all");
    useEffect(() => {
        const controller = new AbortController();
        let timeout: number;
        async function refresh() {
            try {
                const value = await compareRuns(baselineId, candidateId, controller.signal);
                if (controller.signal.aborted) return;
                setComparison(value);
                setError(null);
            } catch (error) {
                if (!controller.signal.aborted) setError(message(error));
            } finally {
                if (!controller.signal.aborted) timeout = window.setTimeout(() => void refresh(), 2000);
            }
        }
        void refresh();
        return () => { controller.abort(); window.clearTimeout(timeout); };
    }, [baselineId, candidateId]);
    return (
        <div className="run-comparison">
            {error && <p className="run-error" role="alert">{error} Comparison may be out of date.</p>}
            {!comparison ? <p className="run-muted">Loading comparison…</p> : <>
                <div className="run-settings-grid">
                    <ConfigSummary run={comparison.baseline} label="Baseline" />
                    <ConfigSummary run={comparison.candidate} label="Candidate" />
                </div>
                {comparison.summary.pending > 0 && <p className="run-notice" role="status">
                    {comparison.summary.pending} cases are pending. Wait for both runs before judging regressions.
                </p>}
                <div className="run-filters" aria-label="Filter comparison cases">
                    <button type="button" className="run-secondary" aria-pressed={filter === "all"}
                        onClick={() => setFilter("all")}>All ({comparison.cases.length})</button>
                    {Object.entries(comparison.summary).map(([change, count]) => (
                        <button type="button" className="run-secondary" key={change} aria-pressed={filter === change}
                            onClick={() => setFilter(change as CaseChange)}>
                            {change} ({count})
                        </button>
                    ))}
                </div>
                <div className="run-table-scroll" tabIndex={0} role="region" aria-label="Per-case comparison table">
                    <table className="run-table">
                        <thead><tr><th scope="col">Case</th><th scope="col">Baseline outcome / score</th>
                            <th scope="col">Candidate outcome / score</th><th scope="col">Change</th></tr></thead>
                        <tbody>{comparison.cases.filter((row) => filter === "all" || row.change === filter)
                            .map((row) => (
                            <tr key={row.caseId}>
                                <th scope="row">{row.caseName}</th>
                                <td><Badge value={row.baseline.outcome} /> <span>{number(row.baseline.score)}</span></td>
                                <td><Badge value={row.candidate.outcome} /> <span>{number(row.candidate.score)}</span></td>
                                <td><Badge value={row.change} /></td>
                            </tr>
                        ))}</tbody>
                    </table>
                </div>
                {!comparison.cases.some((row) => filter === "all" || row.change === filter)
                    && <p className="run-empty">No cases match this filter.</p>}
                <p className="run-muted">
                    Regression: pass → fail. Improvement: fail → pass. Warning: both pass, but the score drops.
                </p>
            </>}
        </div>
    );
}

function ConfigSummary({ run, label = "Saved mock settings" }: { run: Run; label?: string }) {
    const config = { ...emptyConfig, ...run.mockConfig };
    return (
        <div className="run-config-summary">
            <h3>{label}</h3>
            <p className="run-muted">{run.id.slice(0, 8)} · {run.promptVersion} · {run.provider} / {run.model}</p>
            {run.provider === "mock" ? <p className="run-muted">
                Seed: {config.seed} · changed labels: {percent(config.wrongLabelRate)}
                {" · "}invalid JSON: {percent(config.invalidJsonRate)}
                {" · "}missing evidence: {percent(config.missingEvidenceRate)} · added latency: {config.latencyMs} ms
            </p> : <p className="run-muted">Mock settings do not apply to this provider.</p>}
        </div>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return <div className="run-stat"><span>{label}</span><strong>{value}</strong></div>;
}

function Badge({ value }: { value: string }) {
    return <span className={`run-badge run-badge-${value}`}>{value.replaceAll("_", " ")}</span>;
}

function runLabel(report: RunReport) {
    const dataset = `${report.run.dataset.name} v${report.run.dataset.version}`;
    return `${report.run.id.slice(0, 8)} · ${dataset} · ${report.run.promptVersion}`;
}

function number(value: number | null, suffix = "") {
    return value === null ? "—" : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${suffix}`;
}

function percent(value: number) {
    return `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function message(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
