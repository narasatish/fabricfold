-- A restricted role for the application.
--
-- The security audit found the app connects as `postgres`, the database owner.
-- That is why dropping the ledger trigger succeeded: the guards stop BUGS, but
-- they would not stop someone holding a leaked connection string, because that
-- identity can remove them and then delete payments freely.
--
-- This role can read and write rows — everything the app actually does — but
-- cannot DROP a trigger, ALTER a table, or remove a constraint. A leaked
-- credential then costs you data exposure, not the loss of the audit trail
-- that would prove what happened.
--
-- Run as the database owner, ONCE, then point DATABASE_URL/DIRECT_URL at
-- fabricfold_app instead of postgres.
--
--   psql "<owner connection string>" -f scripts/create-app-role.sql
--
-- Choose your own password and keep it out of chat and version control.

\set app_password 'CHANGE_ME_BEFORE_RUNNING'

-- 1. The role itself. NOSUPERUSER/NOCREATEDB/NOCREATEROLE are the point.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'fabricfold_app') THEN
    CREATE ROLE fabricfold_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

ALTER ROLE fabricfold_app WITH PASSWORD :'app_password';

-- 2. Reach the schema, but do not own it — ownership implies the right to
--    drop things in it.
GRANT USAGE ON SCHEMA public TO fabricfold_app;

-- 3. Row-level work only. No TRUNCATE: it bypasses row triggers entirely,
--    which would let the ledger be emptied without the guard ever firing.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO fabricfold_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fabricfold_app;

-- 4. Same rights on tables added later, so a new model does not silently
--    become unreadable after the next deploy.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fabricfold_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO fabricfold_app;

-- 5. Explicitly NOT granted, and each for a reason:
--      CREATE on schema  — could add tables, or shadow existing ones
--      ownership         — implies DROP on every object
--      superuser         — bypasses the ledger triggers outright
--
-- Consequence to plan for: `prisma db push` needs DDL, so the DEPLOY step must
-- keep using the owner credential while the RUNNING app uses this one. Set
-- DIRECT_URL (migrations, owner) and DATABASE_URL (runtime, restricted)
-- differently — the code already reads them separately.

-- 6. Verify. Should return false, then fail with a permission error.
--    If the DROP succeeds, this script has not done its job.
SELECT rolsuper AS is_superuser FROM pg_roles WHERE rolname = 'fabricfold_app';
-- SET ROLE fabricfold_app;
-- DROP TRIGGER ff_protect ON public."Payment";  -- expect: must be owner
-- RESET ROLE;
