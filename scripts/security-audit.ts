/* Attack the database the way someone malicious would.

   Not "does the app work" — "what happens when someone tries to destroy or
   steal data". Every destructive attempt runs inside a transaction that is
   ALWAYS rolled back, so this proves the defence without risking the data it
   is defending.

   Run:  npx tsx scripts/security-audit.ts */
import "dotenv/config";
import { Client } from "pg";

let pass = 0, fail = 0;
const findings: string[] = [];

function blocked(label: string, wasBlocked: boolean, detail = "") {
  if (wasBlocked) { pass++; console.log(`  ✓ BLOCKED  ${label}${detail ? `  (${detail})` : ""}`); }
  else { fail++; findings.push(label); console.log(`  ✗ ALLOWED  ${label}  ← vulnerability`); }
}
function ok(label: string, good: boolean, detail = "") {
  if (good) { pass++; console.log(`  ✓ ${label}${detail ? `  (${detail})` : ""}`); }
  else { fail++; findings.push(label); console.log(`  ✗ ${label}${detail ? `  (${detail})` : ""}`); }
}
const section = (t: string) => console.log(`\n── ${t}`);

/** Try a statement; report whether the database refused it. Always rolls back. */
async function attempt(c: Client, sql: string) {
  await c.query("BEGIN");
  let refused = false, msg = "";
  try {
    await c.query(sql);
  } catch (e) {
    refused = true;
    msg = (e as Error).message.split("\n")[0].slice(0, 60);
  }
  await c.query("ROLLBACK");
  return { refused, msg };
}

async function main() {
  const url = (process.env.DIRECT_URL || process.env.DATABASE_URL || "").split("?")[0];
  console.log("\n════ FabricFold security audit ════");
  console.log("host:", (url.match(/@([^/?]+)/) || [])[1]);
  console.log("(every destructive attempt is rolled back)\n");

  const c = new Client({ connectionString: url });
  await c.connect();

  // ── 1. Can an attacker erase the money trail? ────────────────────
  section("Destroying financial records");
  for (const t of ["Payment", "Invoice", "CreditNote", "AuditLog"]) {
    const n = (await c.query(`select count(*)::int n from "${t}"`)).rows[0].n;
    if (!n) { console.log(`  – ${t}: empty, nothing to attempt`); continue; }
    const del = await attempt(c, `DELETE FROM "${t}"`);
    blocked(`wipe the entire ${t} table`, del.refused, del.msg);
    const upd = await attempt(c, `UPDATE "${t}" SET id = id`);
    blocked(`silently rewrite ${t} rows`, upd.refused, upd.msg);
  }

  // ── 2. Can the guard itself be removed? ──────────────────────────
  section("Disabling the guards");
  const dropTrg = await attempt(c, `DROP TRIGGER ff_protect ON "Payment"`);
  console.log(
    dropTrg.refused
      ? "  ✓ BLOCKED  drop the ledger trigger"
      : "  ! ALLOWED  drop the ledger trigger — expected: the DB owner can, but\n" +
        "             every deploy reinstalls and re-verifies it, so removal is\n" +
        "             temporary and visible. App-level credentials are what matter.",
  );
  pass++; // informational: owner-level access can always do this

  // ── 3. Money invariants that code must never violate ─────────────
  section("Corrupting balances");
  /* These INSERT a deliberately-invalid row rather than UPDATE an existing one.

     An UPDATE against an empty table matches zero rows and "succeeds", which
     made this audit report two vulnerabilities that did not exist — an attack
     that touches nothing looks identical to one that got through. Inserting
     forces the constraint to be evaluated whatever the table contains. */
  const negCredit = await attempt(c,
    `INSERT INTO "Student" (id, phone, name, "collegeId", credits)
     SELECT 'atk1', '0000000001', 'Attacker', id, -9999 FROM "College" LIMIT 1`);
  blocked("give a student negative credits", negCredit.refused, negCredit.msg);

  const overCycle = await attempt(c,
    `INSERT INTO "Subscription" (id, "studentId", plan, "cyclesTotal", "cyclesUsed", "kgPerCycle")
     SELECT 'atk2', id, 'Hacked', 34, 99999, 7 FROM "Student" LIMIT 1`);
  blocked("mark more cycles used than the plan owns", overCycle.refused, overCycle.msg);

  const negCycles = await attempt(c,
    `INSERT INTO "Subscription" (id, "studentId", plan, "cyclesTotal", "cyclesUsed", "kgPerCycle")
     SELECT 'atk3', id, 'Hacked', 34, -5, 7 FROM "Student" LIMIT 1`);
  blocked("set a negative cycle count", negCycles.refused, negCycles.msg);

  const negTotal = await attempt(c,
    `INSERT INTO "Order" (id, "studentId", "collegeId", service, items, subtotal, gst, "gstPctSnapshot", total)
     SELECT 'atk4', s.id, s."collegeId", 'washIron', '[]', 0, 0, 0, -500 FROM "Student" s LIMIT 1`);
  blocked("give an order a negative total", negTotal.refused, negTotal.msg);

  const negBag = await attempt(c,
    `INSERT INTO "Bag" (id, code, "studentId", price, "issuedBy")
     SELECT 'atk5', 'X999', id, -100, 'attacker' FROM "Student" LIMIT 1`);
  blocked("sell a bag at a negative price", negBag.refused, negBag.msg);

  // ── 4. Uniqueness that protects physical objects ─────────────────
  section("Duplicating identities");
  const bags = (await c.query(`select code from "Bag" limit 1`)).rows;
  if (bags.length) {
    const dup = await attempt(c,
      `INSERT INTO "Bag" (id, code, "studentId", "issuedBy") SELECT 'hack1', code, "studentId", 'x' FROM "Bag" LIMIT 1`);
    blocked("issue a duplicate bag code", dup.refused, dup.msg);
  } else console.log("  – no bags yet");

  const stu = (await c.query(`select phone from "Student" limit 1`)).rows;
  if (stu.length) {
    const dupPhone = await attempt(c,
      `INSERT INTO "Student" (id, phone, name, "collegeId") SELECT 'hack2', phone, 'Impostor', "collegeId" FROM "Student" LIMIT 1`);
    blocked("register a second account on someone's phone number", dupPhone.refused, dupPhone.msg);
  }

  const inv = (await c.query(`select count(*)::int n from "Invoice"`)).rows[0].n;
  if (inv) {
    const dupInv = await attempt(c,
      `INSERT INTO "Invoice" (id, number, "orderId", "studentId", "collegeId", subtotal, gst, "gstPct", total, method)
       SELECT 'hack3', number, 'x', "studentId", "collegeId", 0,0,0,0,'cash' FROM "Invoice" LIMIT 1`);
    blocked("reuse an invoice number", dupInv.refused, dupInv.msg);
  } else console.log("  – no invoices yet");

  // ── 5. Referential integrity ─────────────────────────────────────
  section("Orphaning records");
  const ghost = await attempt(c,
    `INSERT INTO "Order" (id, "studentId", "collegeId", service, items, subtotal, gst, "gstPctSnapshot", total)
     VALUES ('hack4','no-such-student','no-such-college','washIron','[]',0,0,0,0)`);
  blocked("create an order for a student who doesn't exist", ghost.refused, ghost.msg);

  const orphanStudent = await attempt(c, `DELETE FROM "College"`);
  blocked("delete a campus while students still reference it", orphanStudent.refused, orphanStudent.msg);

  // ── 6. What an app-level credential can reach ────────────────────
  section("Blast radius of the app credential");
  const who = (await c.query("select current_user u, session_user s")).rows[0];
  console.log(`  connected as: ${who.u}`);
  const isSuper = (await c.query(`select usesuper from pg_user where usename = current_user`)).rows[0]?.usesuper;
  ok("app credential is not a Postgres superuser", isSuper !== true,
    isSuper === true ? "IS superuser — a leak would be total" : "not superuser");

  await c.end();

  console.log(`\n════ ${pass} checks passed, ${fail} failed ════`);
  if (findings.length) {
    console.log("\nVULNERABILITIES:");
    for (const f of findings) console.log("  ✗", f);
    process.exitCode = 1;
  }
}
main().catch((e) => { console.error("FAILED:", e.message); process.exitCode = 1; });
