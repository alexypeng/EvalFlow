/*
  Warnings:

  - Added the required column `evidence_included` to the `evals` table without a default value. This is not possible if the table is not empty.
  - Added the required column `evidence_supported` to the `evals` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reasonable_risk_label` to the `evals` table without a default value. This is not possible if the table is not empty.
  - Added the required column `task_completion_score` to the `evals` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "evals" DROP CONSTRAINT "evals_job_id_fkey";

-- AlterTable
ALTER TABLE "evals" ADD COLUMN     "evidence_included" BOOLEAN NOT NULL,
ADD COLUMN     "evidence_supported" BOOLEAN NOT NULL,
ADD COLUMN     "reasonable_risk_label" BOOLEAN NOT NULL,
ADD COLUMN     "task_completion_score" INTEGER NOT NULL;

-- AddForeignKey
ALTER TABLE "evals" ADD CONSTRAINT "evals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
