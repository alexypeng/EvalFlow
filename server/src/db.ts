import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

export async function checkDatabaseConnection() {
    const result = await pool.query("select now() as now");
    return result.rows[0];
}

export async function migrate() {
    await pool.query(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;
    `);

    await pool.query(`
          CREATE TABLE IF NOT EXISTS jobs (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              type TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
              input JSONB NOT NULL,
              result JSONB,
              error TEXT,
              attempts INTEGER NOT NULL DEFAULT 0,
              max_attempts INTEGER NOT NULL DEFAULT 3,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
              started_at TIMESTAMPTZ,
              completed_at TIMESTAMPTZ,
              latency_ms INTEGER,
              prompt_tokens INTEGER,
              completion_tokens INTEGER,
              total_tokens INTEGER,
              estimated_cost NUMERIC(12, 6),
              eval_score INTEGER
          );
      `);

    await pool.query(`
          CREATE TABLE IF NOT EXISTS traces (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
              step_name TEXT NOT NULL,
              input JSONB,
              output JSONB,
              latency_ms INTEGER,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
      `);

    await pool.query(`
          CREATE TABLE IF NOT EXISTS evals (
              id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
              job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
              valid_json BOOLEAN NOT NULL,
              has_required_fields BOOLEAN NOT NULL,
              evidence_included BOOLEAN NOT NULL,
              evidence_supported BOOLEAN NOT NULL,
              reasonable_risk_label BOOLEAN NOT NULL,
              task_completion_score INTEGER NOT NULL,
              notes TEXT,
              created_at TIMESTAMPTZ NOT NULL DEFAULT now()
          );
      `);

    await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_jobs_status_created_at
          ON jobs(status, created_at);
      `);

    await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_traces_job_id
          ON traces(job_id);
      `);

    await pool.query(`
          CREATE INDEX IF NOT EXISTS idx_evals_job_id
          ON evals(job_id);
      `);
}
