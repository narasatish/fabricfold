/* Remove the SEED demo rows (prisma/seed.ts) from a database — nothing else.

   Safe by construction:
   - DRY RUN by default: prints what it found and changes nothing.
   - Never reads .env: the target must be passed explicitly as
     TARGET_DATABASE_URL, so it can't silently hit the wrong database.
   - Applying needs BOTH --apply and --confirm-host=<the host it printed>.
   - A row is only "demo" if it matches the seed on phone AND name (students,
     staff) or on exact seed text/amount (expenses, payments, complaint), so a
     real person with a similar phone number is never touched.
   - Ledger rows (Payment / Invoice / CreditNote) are immutable by DB trigger
     and deleting real invoices leaves gaps in GST numbering. They are only
     removed with an extra --include-ledger flag; without it, an apply that
     would need them refuses and changes nothing.
   - Colleges, real students, plans, config and both owners are never touched.

   Usage:
     TARGET_DATABASE_URL="postgres://..." node scripts/cleanup-demo-data.mjs
     TARGET_DATABASE_URL="postgres://..." node scripts/cleanup-demo-data.mjs --apply --confirm-host=<host> [--include-ledger]
   Take Admin -> "Download full backup" BEFORE applying. */
import pg from "pg";
import { pathToFileURL } from "node:url";

const DEMO_STUDENTS = {
  phones: ["9876500011", "9876500022", "9876500033", "9876500044"],
  names: ["Aarav Menon", "Diya Sharma", "Kabir Rao", "Ishita Nair"],
};
const DEMO_STAFF = {
  phones: ["9000000002", "9000000003", "9000000004"],
  names: ["Rhea (Admin)", "Sanjay (Manager)", "Priya (Counter)"],
};
const DEMO_EXPENSE_NOTES = ["Detergent & starch restock", "Electricity"];
const DEMO_STANDALONE_PAYMENTS = [
  { method: "cash", amount: 820, note: "Counter walk-in" },
  { method: "upi", amount: 540, note: "Iron only" },
  { method: "credit", amount: 120, note: "Redeemed credits" },
];

const ids = (rows) => rows.map((r) => r.id);

export async function collect(client) {
  const q = async (sql, params = []) => (await client.query(sql, params)).rows;

  const students = await q(`select id, name, phone from "Student" where phone = any($1) and name = any($2)`, [DEMO_STUDENTS.phones, DEMO_STUDENTS.names]);
  const sIds = ids(students);
  const staff = await q(`select id, name, phone from "Staff" where phone = any($1) and name = any($2)`, [DEMO_STAFF.phones, DEMO_STAFF.names]);
  const stIds = ids(staff);

  const orders = await q(`select id from "Order" where "studentId" = any($1)`, [sIds]);
  const oIds = ids(orders);
  const subs = await q(`select id, "planId" from "Subscription" where "studentId" = any($1)`, [sIds]);
  const subIds = ids(subs);
  const complaints = await q(`select id from "Complaint" where "studentId" = any($1)`, [sIds]);
  const invoices = await q(`select id, number from "Invoice" where "orderId" = any($1)`, [oIds]);
  const creditNotes = await q(`select id from "CreditNote" where "invoiceId" = any($1)`, [ids(invoices)]);
  const linkedPayments = await q(`select id from "Payment" where "orderId" = any($1) or "studentId" = any($2)`, [oIds, sIds]);
  const bags = await q(`select id, code from "Bag" where "studentId" = any($1)`, [sIds]);

  const standalonePayments = [];
  for (const p of DEMO_STANDALONE_PAYMENTS) {
    standalonePayments.push(...(await q(
      `select id from "Payment" where "orderId" is null and "studentId" is null and method = $1 and amount = $2 and note = $3`,
      [p.method, p.amount, p.note],
    )));
  }
  const expenses = await q(`select id from "Expense" where "by" = any($1) and note = any($2)`, [stIds, DEMO_EXPENSE_NOTES]);

  // The seed's "Annual Plan" — only if nothing outside the demo students uses it.
  const plans = [];
  for (const planId of new Set(subs.map((s) => s.planId).filter(Boolean))) {
    const [p] = await q(`select id from "Plan" where id = $1 and name = 'Annual Plan' and price = 6500 and tier = 'gold'`, [planId]);
    if (!p) continue;
    const [{ n }] = await q(`select count(*)::int n from "Subscription" where "planId" = $1 and "studentId" <> all($2)`, [planId, sIds]);
    if (n === 0) plans.push(p);
  }

  const owners = await q(`select name, phone, role from "Staff" where role >= 4 and active order by name`);
  const [{ n: ownerCustomers }] = await q(`select count(*)::int n from "Student" where name = 'Owner (customer)'`);

  return {
    students, staff, orders, subs, complaints, invoices, creditNotes, linkedPayments, standalonePayments,
    expenses, plans, bags, owners, ownerCustomers,
    ledgerIds: {
      creditNotes: ids(creditNotes), invoices: ids(invoices),
      payments: [...new Set([...ids(linkedPayments), ...ids(standalonePayments)])],
    },
    sIds, stIds, oIds, subIds,
  };
}

export function summarise(f) {
  return {
    students: f.students.length, staff: f.staff.length, orders: f.orders.length, subscriptions: f.subs.length,
    complaints: f.complaints.length, bags: f.bags.length, plans: f.plans.length, expenses: f.expenses.length,
    ledger: { payments: f.ledgerIds.payments.length, invoices: f.ledgerIds.invoices.length, creditNotes: f.ledgerIds.creditNotes.length },
  };
}

export async function cleanupDemo(client, { apply = false, includeLedger = false } = {}) {
  const found = await collect(client);
  const counts = summarise(found);
  const ledgerRows = counts.ledger.payments + counts.ledger.invoices + counts.ledger.creditNotes;
  if (!apply) return { applied: false, counts, ledgerRows, owners: found.owners };

  if (ledgerRows > 0 && !includeLedger) {
    throw new Error(`Refusing: ${ledgerRows} ledger row(s) (payments/invoices/credit notes) belong to the demo data. They are immutable financial records and deleting invoices leaves gaps in GST numbering. Re-run with --include-ledger only if you really want them removed. Nothing was changed.`);
  }

  const del = async (table, col, values) => {
    if (!values.length) return;
    await client.query(`delete from "${table}" where "${col}" = any($1)`, [values]);
  };
  await client.query("BEGIN");
  try {
    if (ledgerRows > 0) await client.query("SET LOCAL app.allow_delete = 'on'");
    await del("ComplaintMessage", "complaintId", ids(found.complaints));
    await del("Complaint", "id", ids(found.complaints));
    await del("Notification", "studentId", found.sIds);
    await del("CreditUse", "studentId", found.sIds);
    await del("Compensation", "studentId", found.sIds);
    await del("CycleUse", "subscriptionId", found.subIds);
    await del("Subscription", "id", found.subIds);
    await del("Bag", "studentId", found.sIds);
    await del("GarmentTag", "orderId", found.oIds);
    await del("OrderEvent", "orderId", found.oIds);
    await del("CreditNote", "id", found.ledgerIds.creditNotes);
    await del("Invoice", "id", found.ledgerIds.invoices);
    await del("Payment", "id", found.ledgerIds.payments);
    await del("Order", "id", found.oIds);
    await del("Student", "id", found.sIds);
    await del("Plan", "id", ids(found.plans));
    await del("Payslip", "staffId", found.stIds);
    await del("Attendance", "staffId", found.stIds);
    await del("Staff", "id", found.stIds);
    await del("Expense", "id", ids(found.expenses));
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
  return { applied: true, counts, ledgerRows, owners: found.owners };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const includeLedger = args.includes("--include-ledger");
  const confirmHost = (args.find((a) => a.startsWith("--confirm-host=")) || "").split("=")[1];
  const raw = process.env.TARGET_DATABASE_URL;
  if (!raw) {
    console.error("Set TARGET_DATABASE_URL explicitly (this script never reads .env, so it can't pick the wrong database).");
    process.exit(1);
  }
  const u = new URL(raw);
  const schema = u.searchParams.get("schema");
  u.searchParams.delete("schema");
  console.log(`Target: host=${u.hostname} db=${u.pathname.slice(1)} schema=${schema || "public"}  (${apply ? "APPLY" : "DRY RUN"})`);
  if (apply && confirmHost !== u.hostname) {
    console.error(`Refusing: to apply, pass --confirm-host=${u.hostname}`);
    process.exit(1);
  }
  const needsSsl = /\.render\.com$/.test(u.hostname) || process.env.PGSSL === "1";
  const client = new pg.Client({ connectionString: u.toString(), ssl: needsSsl ? { rejectUnauthorized: false } : undefined });
  await client.connect();
  try {
    if (schema) await client.query(`set search_path to "${schema}"`);
    const r = await cleanupDemo(client, { apply, includeLedger });
    console.log("\nDemo rows found:", JSON.stringify(r.counts, null, 2));
    console.log("\nOwners that will remain:");
    for (const o of r.owners) console.log(`  ${o.name}  +91 ${o.phone}`);
    if (r.owners.length < 2) console.warn("\nWARNING: fewer than 2 active owners exist. Add Satish and Yogesh in Admin -> Staff (role Owner) before/after cleanup.");
    console.log(r.applied ? "\nDONE — demo rows removed." : "\nDRY RUN — nothing was changed. Review the list, take a backup, then re-run with --apply --confirm-host=" + u.hostname);
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
