-- AlterTable
ALTER TABLE "jobs" ALTER COLUMN "run_after" SET DEFAULT date_trunc('milliseconds', CURRENT_TIMESTAMP);
