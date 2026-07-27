/* Final freshness pass before cutover: re-copy every row from Sydney into
   Mumbai (idempotent — ON CONFLICT DO NOTHING for inserts, then an explicit
   UPDATE pass so any row that changed since the last copy is corrected too). */
import { Client } from "pg";
import fs from "node:fs";

const env = Object.fromEntries(
  fs.readFileSync(".env", "utf8").split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    }),
);

const SYDNEY = env.DIRECT_URL;
const MUMBAI = "postgresql://postgres.vhwjdnjsruuarcoqduuu:Madhu0413364@aws-1-ap-south-1.pooler.supabase.com:5432/postgres";

const TABLES = [
  "College", "SlotWindow", "Plan", "Student", "Staff",
  "Subscription", "Order", "OrderEvent", "GarmentTag",
  "Payment", "Invoice", "CreditNote", "FySequence", "CreditUse",
  "Compensation", "Expense", "Payslip", "Complaint", "ComplaintMessage",
  "Notification", "Attendance", "DayClose", "AuditLog", "ErrorLog",
  "Otp", "PushSubscription", "CycleUse", "AppConfig",
];

function stringifyJson(v) {
  if (v !== null && typeof v === "object" && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

async function main() {
  const src = new Client({ connectionString: SYDNEY });
  const dst = new Client({ connectionString: MUMBAI });
  await src.connect();
  await dst.connect();
  await dst.query("SET app.allow_delete = 'on'");

  const summary = [];
  for (const t of TABLES) {
    const { rows } = await src.query(`SELECT * FROM "${t}"`);
    if (rows.length === 0) { summary.push([t, 0, 0, 0]); continue; }

    const cols = Object.keys(rows[0]);
    const pk = "id"; // every table here uses "id" as PK
    const colList = cols.map((c) => `"${c}"`).join(", ");
    let inserted = 0, updated = 0;
    for (const row of rows) {
      const vals = cols.map((c) => stringifyJson(row[c]));
      const placeholders = vals.map((_, i) => `$${i + 1}`).join(", ");
      const setList = cols.filter((c) => c !== pk).map((c) => `"${c}" = EXCLUDED."${c}"`).join(", ");
      try {
        const r = await dst.query(
          `INSERT INTO "${t}" (${colList}) VALUES (${placeholders})
           ON CONFLICT ("${pk}") DO UPDATE SET ${setList}
           RETURNING (xmax = 0) AS inserted`,
          vals,
        );
        if (r.rows[0]?.inserted) inserted++; else updated++;
      } catch (e) {
        console.error(`  ! ${t} row failed:`, e.message.slice(0, 200));
      }
    }
    summary.push([t, rows.length, inserted, updated]);
  }

  console.log("\n=== FRESHNESS PASS SUMMARY ===");
  console.log("table".padEnd(20), "source".padStart(8), "new".padStart(8), "updated".padStart(8));
  for (const [t, src_n, ins, upd] of summary) {
    console.log(t.padEnd(20), String(src_n).padStart(8), String(ins).padStart(8), String(upd).padStart(8));
  }

  await src.end();
  await dst.end();
}

main().catch((e) => { console.error("MIGRATION FAILED:", e.message); process.exit(1); });
