import './App.css'

function App() {
  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">AI agent orchestration</p>
          <h1>EvalFlow</h1>
        </div>
        <div className="status-pill">Local MVP</div>
      </header>

      <section className="dashboard-grid" aria-label="Dashboard overview">
        <article className="panel">
          <h2>Submit Job</h2>
          <p className="muted">
            Retention risk analysis workflow will be wired here next.
          </p>
        </article>

        <article className="panel">
          <h2>Jobs</h2>
          <p className="muted">
            Queued, running, completed, and failed jobs will appear here.
          </p>
        </article>

        <article className="panel panel-wide">
          <h2>Run Details</h2>
          <p className="muted">
            Select a job to inspect result JSON, traces, evals, latency, tokens,
            and errors.
          </p>
        </article>
      </section>
    </main>
  )
}

export default App
