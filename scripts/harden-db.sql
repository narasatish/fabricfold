-- FabricFold database hardening — run against Supabase (session pooler).
-- Idempotent: safe to re-run after any `prisma db push` that creates new tables.
--
-- 1) ROW LEVEL SECURITY on every table, with NO policies.
--    Supabase exposes a public REST API (PostgREST) over the `public` schema;
--    with RLS off, anyone holding the project's anon key could read/write rows.
--    RLS on + zero policies = that door is welded shut. The app itself connects
--    as the table OWNER (postgres role), which bypasses RLS — so nothing breaks.
--
-- 2) REVOKE all table privileges from the API roles (anon / authenticated).
--    Belt and braces on top of RLS.
--
-- 3) IMMUTABLE FINANCIAL RECORDS: Invoice, CreditNote, Payment, AuditLog can
--    never be UPDATEd or DELETEd — by anyone, through any tool, including us.
--    Break-glass (deliberate, owner-only, per-connection):
--      SET app.allow_delete = 'on';   -- then the change is permitted
--    This is how top-tier finance systems protect their ledgers.

-- ---------- 1 + 2: RLS + revokes on all tables ----------
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;

REVOKE ALL ON ALL TABLES    IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES    FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;

-- ---------- 3: ledger immutability ----------
CREATE OR REPLACE FUNCTION public.ff_protect_ledger() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.allow_delete', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'FabricFold: % on % is not allowed — financial records are immutable', TG_OP, TG_TABLE_NAME
    USING HINT = 'Ledger rows can only be corrected by new entries (refunds / credit notes), never edited or deleted.';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Invoice','CreditNote','Payment','AuditLog']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS ff_protect ON public.%I', t);
    EXECUTE format('CREATE TRIGGER ff_protect BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.ff_protect_ledger()', t);
  END LOOP;
END $$;

SELECT 'hardening applied' AS status;
