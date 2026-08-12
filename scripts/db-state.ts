/* Row counts and installed ff_* constraints. Used to tell a real defence from
   an attack that simply matched no rows. Read-only. */
import "dotenv/config";
import { Client } from "pg";

async function main() {
  const c = new Client({ connectionString: (process.env.DIRECT_URL || "").split("?")[0] });
  await c.connect();
  for (const t of ["Student", "Subscription", "Order", "Bag", "Payment", "Invoice"]) {
    const r = await c.query(`select count(*)::int n from "${t}"`);
    console.log(t.padEnd(14), r.rows[0].n);
  }
  const r2 = await c.query(`select conname from pg_constraint where conname like 'ff\\_%' order by conname`);
  console.log("\nff_* constraints:", r2.rowCount);
  for (const row of r2.rows) console.log("  ", row.conname);
  await c.end();
}
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
