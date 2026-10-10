-- Highway storage seam. Portable Postgres (Supabase Free now; Render later).
-- Plain SQL. No vendor extensions required.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS docs (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts_num BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS docs_newest
  ON docs (collection, ts_num DESC NULLS LAST, created_at DESC);

CREATE OR REPLACE FUNCTION highway_notify_doc() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('highway_docs', NEW.collection || ':' || NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS docs_notify ON docs;
CREATE TRIGGER docs_notify
  AFTER INSERT OR UPDATE ON docs
  FOR EACH ROW EXECUTE FUNCTION highway_notify_doc();
