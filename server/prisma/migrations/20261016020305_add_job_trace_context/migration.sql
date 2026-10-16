-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "trace_parent" TEXT,
ADD COLUMN     "trace_state" TEXT;
