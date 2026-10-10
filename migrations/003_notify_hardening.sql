-- C1/I1: harden the docs_notify trigger.
--
-- 1) Restrict NOTIFY fan-out to low-churn collections. High-churn rows
--    (highway_presence heartbeats, etc.) no longer fan out to every SSE client.
-- 2) Session-GUC skip so backfills can silence the notify thundering herd:
--    backfill connections can `SET LOCAL highway.skip_notify = '1'` inside
--    their transaction and the trigger becomes a no-op for that session.

CREATE OR REPLACE FUNCTION highway.highway_notify_doc() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('highway.skip_notify', true) IS NOT DISTINCT FROM '1' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_notify('highway_events', json_build_object('type', NEW.collection, 'id', NEW.id)::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS docs_notify ON highway.docs;
CREATE TRIGGER docs_notify
  AFTER INSERT OR UPDATE ON highway.docs
  FOR EACH ROW
  WHEN (NEW.collection IN ('highway_messages','highway_code','highway_dm','highway_tasks','highway_activity'))
  EXECUTE FUNCTION highway.highway_notify_doc();
