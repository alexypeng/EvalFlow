function App() {
    return (
        <main className="min-h-screen bg-slate-100 px-5 py-8 text-slate-950">
            <div className="mx-auto max-w-6xl">
                <header className="mb-6 flex items-start justify-between gap-6">
                    <div>
                        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">
                            AI agent orchestration
                        </p>
                        <h1 className="mt-1 text-3xl font-semibold tracking-normal">
                            EvalFlow
                        </h1>
                    </div>

                    <span className="rounded-full border border-slate-300 bg-white px-3 py-1 text-sm font-semibold text-slate-700">
                        Local MVP
                    </span>
                </header>

                <section
                    className="grid gap-4 lg:grid-cols-[320px_1fr]"
                    aria-label="Dashboard overview"
                >
                    <article className="min-h-44 rounded-lg border border-slate-200 bg-white p-5">
                        <h2 className="text-base font-semibold">Submit Job</h2>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                            Retention risk analysis workflow will be wired here
                            next.
                        </p>
                    </article>

                    <article className="min-h-44 rounded-lg border border-slate-200 bg-white p-5">
                        <h2 className="text-base font-semibold">Jobs</h2>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                            Queued, running, completed, and failed jobs will
                            appear here.
                        </p>
                    </article>

                    <article className="min-h-72 rounded-lg border border-slate-200 bg-white p-5 lg:col-span-2">
                        <h2 className="text-base font-semibold">Run Details</h2>
                        <p className="mt-2 text-sm leading-6 text-slate-600">
                            Select a job to inspect result JSON, traces, evals,
                            latency, tokens, and errors.
                        </p>
                    </article>
                </section>
            </div>
        </main>
    );
}

export default App;
