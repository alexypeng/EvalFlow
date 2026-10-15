-- Rename in place: existing exhausted jobs retain their IDs, errors, traces and evaluations.
ALTER TYPE "JobStatus" RENAME VALUE 'failed' TO 'dead_letter';
