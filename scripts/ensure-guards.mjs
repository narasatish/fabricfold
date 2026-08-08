/* Make sure the ledger-immutability guards exist on whatever database we deploy
   against.

   The old Sydney database had these; Mumbai — the LIVE one — appeared to have
   none, meaning production was less protected than dev. A payment, invoice,
   credit note or audit row could be edited or deleted with nothing to stop it,
   which is precisely the thing an accounting trail must never allow.

   Runs on every deploy, right after the schema sync, and is idempotent. Running
   it each time also repairs the case where a schema change recreates a table
   and silently drops its trigger.

   There is a deliberate escape hatch: `SET app.allow_delete = 'on'` inside a
   transaction lets a genuine correction through. It's off unless explicitly
   set, so accidents are blocked while a real fix stays possible. */
import pg from "pg";

/* On Vercel the env vars are already in the process; locally they live in .env.
   Loading dotenv when present makes this script runnable by hand, which is what
   lets it be verified rather than assumed. */
try { (await import("dotenv")).config(); } catch { /* not installed: fine on Vercel */ }

const GUARDED = ["Payment", "Invoice", "CreditNote", "AuditLog"];

const FN = `
CREATE OR REPLACE FUNCTION public.ff_protect_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF current_setting('app.allow_delete', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'FabricFold: % on % is not allowed — financial records are immutable', TG_OP, TG_TABLE_NAME
    USING HINT = 'Ledger rows can only be corrected by new entries (refunds / credit notes), never edited or deleted.';
END;
$function$`;

const url = (process.env.DIRECT_URL || process.env.DATABASE_URL || "").split("?")[0];
if (!/^postgres(ql)?:\/\//.test(url)) {
  console.log("[guards] No Postgres URL — skipping.");
  process.exit(0);
}

const host = (url.match(/@([^/?]+)/) || [])[1] || "unknown";
const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
  await client.query(FN);

  let added = 0, already = 0, absent = 0;
  for (const table of GUARDED) {
    const exists = await client.query(
      `select 1 from information_schema.tables where table_schema='public' and table_name=$1`, [table]);
    if (!exists.rowCount) { absent++; console.log(`[guards] ${table}: table not present, skipped`); continue; }

    const had = await client.query(
      `select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
       join pg_namespace n on n.oid=c.relnamespace
       where not t.tgisinternal and n.nspname='public' and c.relname=$1 and t.tgname='ff_protect'`, [table]);

    // Drop-then-create rather than "if missing": guarantees the definition
    // matches this file even if an older variant is installed.
    await client.query(`DROP TRIGGER IF EXISTS ff_protect ON public."${table}"`);
    await client.query(
      `CREATE TRIGGER ff_protect BEFORE DELETE OR UPDATE ON public."${table}"
       FOR EACH ROW EXECUTE FUNCTION ff_protect_ledger()`);

    if (had.rowCount) already++; else { added++; console.log(`[guards] ${table}: guard ADDED`); }
  }
  console.log(`[guards] ${host} — ${added} added, ${already} already present, ${absent} skipped`);

  /* Installing a trigger and having it actually STOP a write are different
     claims. A trigger can exist and still protect nothing — wrong events, a
     function that returns instead of raising. So attempt a real UPDATE inside
     a transaction that is always rolled back, and fail the build if it goes
     through. "The installer said OK" is not evidence. */
  let verified = 0, unverifiable = 0;
  for (const table of GUARDED) {
    const rows = await client.query(`select count(*)::int n from information_schema.tables
      where table_schema='public' and table_name=$1`, [table]);
    if (!rows.rowCount || !rows.rows[0].n) continue;

    const any = await client.query(`select count(*)::int n from "${table}"`);
    if (!any.rows[0].n) { unverifiable++; continue; } // nothing to attempt against

    await client.query("BEGIN");
    let blocked = false;
    try {
      await client.query(`UPDATE "${table}" SET id = id WHERE ctid = (SELECT ctid FROM "${table}" LIMIT 1)`);
    } catch {
      blocked = true;
    }
    await client.query("ROLLBACK"); // nothing is ever committed either way

    if (!blocked) {
      console.error(`[guards] VERIFY FAILED: an UPDATE on ${table} was NOT blocked.`);
      process.exit(1);
    }
    verified++;
  }
  console.log(
    `[guards] verified ${verified} table(s) actually reject writes` +
      (unverifiable ? `; ${unverifiable} empty, nothing to attempt against` : ""),
  );
} catch (e) {
  // A deploy without ledger protection is worse than no deploy: fail the build
  // and leave the previous deployment live.
  console.error(`[guards] FAILED on ${host}: ${e.message}`);
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
