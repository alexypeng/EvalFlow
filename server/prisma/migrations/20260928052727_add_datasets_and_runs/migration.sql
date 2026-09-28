-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high');

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "case_id" UUID,
ADD COLUMN     "run_id" UUID;

-- CreateTable
CREATE TABLE "datasets" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "datasets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dataset_cases" (
    "id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "expected_risk" "RiskLevel" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dataset_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "runs" (
    "id" UUID NOT NULL,
    "dataset_id" UUID NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "datasets_name_version_key" ON "datasets"("name", "version");

-- CreateIndex
CREATE INDEX "dataset_cases_dataset_id_idx" ON "dataset_cases"("dataset_id");

-- CreateIndex
CREATE UNIQUE INDEX "dataset_cases_dataset_id_name_key" ON "dataset_cases"("dataset_id", "name");

-- CreateIndex
CREATE INDEX "runs_dataset_id_idx" ON "runs"("dataset_id");

-- CreateIndex
CREATE INDEX "jobs_run_id_idx" ON "jobs"("run_id");

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "dataset_cases"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dataset_cases" ADD CONSTRAINT "dataset_cases_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runs" ADD CONSTRAINT "runs_dataset_id_fkey" FOREIGN KEY ("dataset_id") REFERENCES "datasets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
