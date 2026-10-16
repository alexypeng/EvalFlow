-- Old rows have no known queue-entry time. The default applies only to future inserts.
ALTER TABLE "jobs" ADD COLUMN "queued_at" TIMESTAMP(3);
ALTER TABLE "jobs" ALTER COLUMN "queued_at" SET DEFAULT date_trunc('milliseconds', clock_timestamp());
