/* Confirm which database we're pointed at, and whether the ledger-immutability
   guard exists there. The QA teardown was blocked by such a trigger on the old
   Sydney project; the Mumbai dashboard showed none, which would mean production
   is LESS protected than dev. Read-only. */
import "dotenv/config";
import { Client } from "pg";

async function main() {
  const url = (process.env.DIRECT_URL || process.env.DATABASE_URL || "").split("?")[0];
  console.log("host   :", (url.match(/@([^/?]+)/) || [])[1] || "unknown");
  const c = new Client({ connectionString: url });
  await c.connect();

  const who = await c.query("select current_database() db, inet_server_addr() addr, version() v");
  console.log("db     :", who.rows[0].db);
  console.log("pg     :", String(who.rows[0].v).split(" ").slice(0, 2).join(" "));

  const trg = await c.query(`
    select t.tgname, c.relname
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal and n.nspname = 'public'
    order by c.relname, t.tgname`);
  console.log("\ntriggers in public:", trg.rowCount);
  for (const r of trg.rows) console.log("  ", r.relname.padEnd(18), r.tgname);

  const tables = await c.query(
    `select count(*)::int n from information_schema.tables where table_schema='public'`,
  );
  console.log("\ntables in public  :", tables.rows[0].n);
  for (const t of ["Bag", "Plan", "Order", "Payment", "Complaint"]) {
    const r = await c.query(
      `select count(*)::int n from information_schema.tables where table_schema='public' and table_name=$1`, [t]);
    console.log(`  ${t.padEnd(10)} ${r.rows[0].n ? "present" : "MISSING"}`);
  }
  const rows = await c.query(`select count(*)::int n from "Student"`);
  console.log("\nstudents          :", rows.rows[0].n);
  const plans = await c.query(`select name, tier, price from "Plan" order by price`);
  console.log("plans             :", plans.rowCount);
  for (const p of plans.rows) console.log("  ", String(p.name).padEnd(10), String(p.tier ?? "—").padEnd(8), p.price);
  await c.end();
}
main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
