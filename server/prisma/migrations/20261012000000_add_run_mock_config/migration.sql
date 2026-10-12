-- AlterTable
ALTER TABLE "runs" ADD COLUMN     "mock_config" JSONB NOT NULL DEFAULT '{}';
