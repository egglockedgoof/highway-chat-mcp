-- Email/password auth for the Highway web UI (Supabase-backed, no Firebase).
-- password_hash format: <hex-salt>:<hex-sha256(salt + ":" + password)>.
-- The bridge verifies credentials in POST /api/auth/login and, on success,
-- returns the WIDGET_TOKEN so the browser never needs a hardcoded secret.
CREATE TABLE IF NOT EXISTS highway.highway_users (
  email TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
