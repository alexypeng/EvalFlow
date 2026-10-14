-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "lease_expires_at" TIMESTAMP(3),
ADD COLUMN     "lease_token" UUID,
ADD COLUMN     "locked_by" UUID,
ADD COLUMN     "run_after" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "jobs_status_lease_expires_at_idx" ON "jobs"("status", "lease_expires_at");

-- CreateIndex
CREATE INDEX "jobs_status_run_after_created_at_idx" ON "jobs"("status", "run_after", "created_at");
