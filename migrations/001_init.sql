-- Highway storage seam. All objects live in schema highway (owned by highway_bridge).
-- Portable Postgres (Supabase Free now; Render later). No vendor extensions.

CREATE SCHEMA IF NOT EXISTS highway;

CREATE TABLE IF NOT EXISTS highway.schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS highway.docs (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  fields JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts_num BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);

CREATE INDEX IF NOT EXISTS docs_newest
  ON highway.docs (collection, ts_num DESC NULLS LAST, created_at DESC);

CREATE OR REPLACE FUNCTION highway.highway_notify_doc() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('highway_events', json_build_object('type', NEW.collection, 'id', NEW.id)::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS docs_notify ON highway.docs;
CREATE TRIGGER docs_notify
  AFTER INSERT OR UPDATE ON highway.docs
  FOR EACH ROW EXECUTE FUNCTION highway.highway_notify_doc();
