-- Migration: 20260718_auth_session.sql
-- Purpose: Create the server-side session table used by connect-pg-simple.
-- Scope:   Idempotent. Safe to re-run.
-- Note:    server.js runs with createTableIfMissing:false in production, so this
--          migration MUST be applied before the new auth code goes live in prod.
--          connect-pg-simple@10.0.0 official schema (see node_modules/connect-pg-simple/table.sql).

CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'session_pkey'
  ) THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid");
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
