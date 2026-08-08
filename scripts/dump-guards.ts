/* Print the exact definitions of the ff_protect ledger guards, so they can be
   recreated verbatim on another database. Read-only. */
import "dotenv/config";
import { Client } from "pg";

async function main() {
  const url = (process.env.DIRECT_URL || process.env.DATABASE_URL || "").split("?")[0];
  const c = new Client({ connectionString: url });
  await c.connect();
  const fns = await c.query(
    `select p.proname, pg_get_functiondef(p.oid) def from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where n.nspname='public' and p.proname ilike '%protect%'`);
  for (const f of fns.rows) console.log(`=== FUNCTION ${f.proname} ===\n${f.def}\n`);
  const trg = await c.query(
    `select c.relname, pg_get_triggerdef(t.oid) def from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
     where not t.tgisinternal and n.nspname='public' order by c.relname`);
  for (const t of trg.rows) console.log(`=== TRIGGER on ${t.relname} ===\n${t.def};\n`);
  await c.end();
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
