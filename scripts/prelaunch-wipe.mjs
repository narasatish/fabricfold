/* One-off pre-launch wipe: keeps ONLY St Mary's students (with their plans/subscriptions/bags),
   colleges, plans, app config, staff and invoice sequences. Deletes all test transactions and
   non-St-Mary's students. Rehearsal by default (rolls back); pass --apply to commit.
   Usage: TARGET_DATABASE_URL=... node scripts/prelaunch-wipe.mjs [--apply] */
import pg from "pg";

const apply = process.argv.includes("--apply");
const raw = process.env.TARGET_DATABASE_URL;
if (!raw) { console.error("Set TARGET_DATABASE_URL"); process.exit(1); }
const u = new URL(raw);
console.log(`Target host=${u.hostname} (${apply ? "APPLY" : "REHEARSAL, will roll back"})`);
const c = new pg.Client({ connectionString: raw, ssl: /render\.com$/.test(u.hostname) ? { rejectUnauthorized: false } : undefined });
await c.connect();
const n = async (t) => (await c.query(`select count(*)::int n from "${t}"`)).rows[0].n;
const nonSm = `select id from "Student" where "collegeId" <> 'stmarys'`;
const steps = [
  "ComplaintMessage", "Complaint", "CreditNote", "Invoice", "Payment", "CycleUse", "GarmentTag", "OrderEvent", "Order",
  "CreditUse", "Compensation", "Notification", "Expense", "Payslip", "Attendance", "ErrorLog", "Otp", "WaVerify",
].map((t) => [t, `delete from "${t}"`]).concat([
  ["Subscription (non-St Mary's)", `delete from "Subscription" where "studentId" in (${nonSm})`],
  ["Bag (non-St Mary's)", `delete from "Bag" where "studentId" in (${nonSm})`],
  ["PushSubscription (non-St Mary's)", `delete from "PushSubscription" where "userKind" = 'student' and "userId" in (${nonSm})`],
  ["Student (non-St Mary's)", `delete from "Student" where "collegeId" <> 'stmarys'`],
]);
await c.query("BEGIN");
try {
  await c.query("SET LOCAL app.allow_delete = 'on'");
  for (const [label, sql] of steps) { const r = await c.query(sql); if (r.rowCount) console.log("deleted", r.rowCount, label); }
  for (const t of ["Student", "Staff", "Subscription", "Bag", "Plan", "College", "AppConfig", "Order", "Payment"]) console.log("now", t, await n(t));
  await c.query(apply ? "COMMIT" : "ROLLBACK");
  console.log(apply ? "COMMITTED" : "ROLLED BACK (rehearsal only)");
} catch (e) {
  await c.query("ROLLBACK");
  console.error("FAILED, rolled back:", e.message);
  process.exitCode = 1;
}
await c.end();
