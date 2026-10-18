SELECT count(*) FROM jobs
WHERE status = 'running'
   OR (status = 'queued' AND run_after <= CURRENT_TIMESTAMP)
