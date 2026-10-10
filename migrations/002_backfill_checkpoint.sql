-- Resumable backfill cursor. Lives in schema highway. No secrets.
CREATE TABLE IF NOT EXISTS highway.backfill_checkpoint (
  collection TEXT PRIMARY KEY,
  page_token TEXT,
  docs INT NOT NULL DEFAULT 0,
  reads INT NOT NULL DEFAULT 0,
  upserts INT NOT NULL DEFAULT 0,
  done BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
