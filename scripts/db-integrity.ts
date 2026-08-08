/* Referential and business-rule integrity audit.

   Foreign keys catch dangling references, but they cannot catch a subscription
   whose cycle count disagrees with its own buckets, or a paid order with no
   payment behind it. Those are the corruptions that surface as an angry
   student rather than a database error. Read-only. */
import "dotenv/config";
import { db } from "../lib/db";

let issues = 0;
const bad = (label: string, n: number, detail = "") => {
  if (n) { issues += n; console.log(`  ✗ ${label}: ${n}${detail ? `  ${detail}` : ""}`); }
  else console.log(`  ✓ ${label}`);
};

type Bucket = { service: string; cycles: number; used: number };

async function main() {
  const url = process.env.DATABASE_URL || "";
  console.log("host:", (url.match(/@([^/?]+)/) || [])[1], "\n");

  console.log("Referential integrity");
  const students = await db.student.findMany({ select: { id: true, collegeId: true, washDay: true } });
  const collegeIds = new Set((await db.college.findMany({ select: { id: true } })).map((c) => c.id));
  bad("every student belongs to a real campus", students.filter((s) => !collegeIds.has(s.collegeId)).length);

  const orders = await db.order.findMany({ select: { id: true, studentId: true, status: true, paid: true, total: true, usedCycle: true } });
  const studentIds = new Set(students.map((s) => s.id));
  bad("every order belongs to a real student", orders.filter((o) => !studentIds.has(o.studentId)).length);

  const bags = await db.bag.findMany({ select: { id: true, code: true, studentId: true, status: true } });
  bad("every bag belongs to a real student", bags.filter((b) => !studentIds.has(b.studentId)).length);

  console.log("\nBusiness rules");
  const dupCodes = bags.length - new Set(bags.map((b) => b.code)).size;
  bad("bag codes are unique", dupCodes);

  const perStudentActive = new Map<string, number>();
  for (const b of bags.filter((b) => b.status === "active")) {
    perStudentActive.set(b.studentId, (perStudentActive.get(b.studentId) || 0) + 1);
  }
  bad("no student holds two active bags", [...perStudentActive.values()].filter((n) => n > 1).length);

  const subs = await db.subscription.findMany();
  let mismatched = 0, negative = 0, over = 0;
  for (const s of subs) {
    const buckets = (s.buckets as unknown as Bucket[] | null) || null;
    if (buckets?.length) {
      const used = buckets.reduce((a, b) => a + b.used, 0);
      const total = buckets.reduce((a, b) => a + b.cycles, 0);
      if (used !== s.cyclesUsed) mismatched++;
      if (total !== s.cyclesTotal) mismatched++;
      if (buckets.some((b) => b.used > b.cycles)) over++;
    }
    if (s.cyclesUsed < 0) negative++;
    if (s.cyclesUsed > s.cyclesTotal) over++;
  }
  bad("bucket totals agree with cyclesUsed/cyclesTotal", mismatched);
  bad("no negative cycle counts", negative);
  bad("nobody has used more cycles than they own", over);

  console.log("\nMoney");
  const unpaidCollected = orders.filter((o) => o.status === "collected" && !o.paid && Number(o.total) > 0);
  bad("nothing collected while money was owed", unpaidCollected.length,
    unpaidCollected.slice(0, 3).map((o) => `#${o.id.slice(-4)}`).join(" "));

  const negTotals = orders.filter((o) => Number(o.total) < 0);
  bad("no negative order totals", negTotals.length);

  const invoices = await db.invoice.findMany({ select: { number: true } });
  bad("invoice numbers are unique", invoices.length - new Set(invoices.map((i) => i.number)).size);

  // Gap-free per-FY numbering is the rule the tax trail depends on.
  const byFy = new Map<string, number[]>();
  for (const i of invoices) {
    const m = /^INV-(\d+)-(\d+)$/.exec(i.number);
    if (!m) continue;
    (byFy.get(m[1]) || byFy.set(m[1], []).get(m[1])!).push(Number(m[2]));
  }
  let gaps = 0;
  for (const [, nums] of byFy) {
    nums.sort((a, b) => a - b);
    for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) gaps++;
  }
  bad("invoice numbering has no gaps", gaps);

  console.log("\nOperational");
  const noWashDay = students.filter((s) => s.washDay === null).length;
  bad("every student has a wash day", noWashDay);
  // CycleUse.subscriptionId is a required FK, so an orphan is impossible by
  // construction — check instead that every logged use points at a live row.
  const subIds = new Set(subs.map((s) => s.id));
  const uses = await db.cycleUse.findMany({ select: { subscriptionId: true } });
  bad("every cycle-use row points at a live subscription",
    uses.filter((u) => !subIds.has(u.subscriptionId)).length);

  console.log(`\n${issues === 0 ? "✓ no integrity issues found" : `✗ ${issues} issue(s) found`}`);
  if (issues) process.exitCode = 1;
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => db.$disconnect());
