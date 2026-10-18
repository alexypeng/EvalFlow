BEGIN;

-- No job data in the payload. Multiple queued rows in one transaction can share one wakeup.
-- Delivery happens only on commit; rollback cannot wake workers for uncommitted jobs.
CREATE FUNCTION notify_evalflow_queued_job() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'queued' AND
        (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
        PERFORM pg_catalog.pg_notify('evalflow_jobs', '');
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER jobs_notify_queued
AFTER INSERT OR UPDATE OF status ON jobs
FOR EACH ROW EXECUTE FUNCTION notify_evalflow_queued_job();

COMMIT;
