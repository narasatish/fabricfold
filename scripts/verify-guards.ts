/* Prove the ledger guards actually block writes, rather than merely existing.
   A trigger that is present but misconfigured protects nothing, so this
   attempts a real UPDATE and a real DELETE inside a transaction that is always
   rolled back. Touches no data. */
import "dotenv/config";
import { Client } from "pg";

const GUARDED = ["Payment", "Invoice", "CreditNote", "AuditLog"];
let pass = 0, fail = 0;
const ok = (l: string, good: boolean, d = "") => {
  if (good) { pass++; console.log(`  ✓ ${l}${d ? `  (${d})` : ""}`); }
  else { fail++; console.log(`  ✗ ${l}${d ? `  (${d})` : ""}`); }
};

async function main() {
  const url = (process.env.DIRECT_URL || process.env.DATABASE_URL || "").split("?")[0];
  console.log("host:", (url.match(/@([^/?]+)/) || [])[1], "\n");
  const c = new Client({ connectionString: url });
  await c.connect();

  for (const t of GUARDED) {
    const has = await c.query(`select count(*)::int n from "${t}"`);
    if (!has.rows[0].n) { console.log(`  – ${t}: no rows to test against`); continue; }

    for (const op of ["UPDATE", "DELETE"] as const) {
      await c.query("BEGIN");
      let blocked = false, msg = "";
      try {
        if (op === "DELETE") await c.query(`DELETE FROM "${t}" WHERE ctid = (SELECT ctid FROM "${t}" LIMIT 1)`);
        else await c.query(`UPDATE "${t}" SET id = id WHERE ctid = (SELECT ctid FROM "${t}" LIMIT 1)`);
      } catch (e) {
        blocked = true;
        msg = (e as Error).message.slice(0, 46);
      }
      await c.query("ROLLBACK"); // nothing is ever committed
      ok(`${t} ${op} blocked`, blocked, msg);
    }
  }

  // The escape hatch must still work, or a legitimate correction is impossible.
  await c.query("BEGIN");
  await c.query("SET LOCAL app.allow_delete = 'on'");
  let allowed = false;
  try {
    await c.query(`UPDATE "AuditLog" SET id = id WHERE ctid = (SELECT ctid FROM "AuditLog" LIMIT 1)`);
    allowed = true;
  } catch { /* stayed blocked */ }
  await c.query("ROLLBACK");
  ok("escape hatch permits a deliberate correction", allowed);

  await c.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
}
main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
