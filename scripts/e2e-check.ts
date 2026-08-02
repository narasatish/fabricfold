/* End-to-end check of the new schema and logic against a REAL database.

   Exercises the parts that had never been executed: wash-day assignment on a
   new student, bag code allocation, complaint photos, the free-re-service link
   and the retention query. Creates its own throwaway rows and deletes them
   again, so it is safe to run against a working database.

   Run:  npx tsx scripts/e2e-check.ts */
import "dotenv/config";
import { db } from "../lib/db";
import { assignWashDay } from "../lib/washday-server";
import { allocateBagCode, bagKindFor, parseBagCode } from "../lib/bagcode";
import { WEEKDAY_NAMES } from "../lib/washday";

const TAG = "e2echk";
let pass = 0, fail = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function cleanup() {
  const students = await db.student.findMany({ where: { id: { startsWith: TAG } }, select: { id: true } });
  const ids = students.map((s) => s.id);
  if (ids.length) {
    const complaints = await db.complaint.findMany({ where: { studentId: { in: ids } }, select: { id: true } });
    await db.complaintMessage.deleteMany({ where: { complaintId: { in: complaints.map((c) => c.id) } } });
    await db.complaint.deleteMany({ where: { studentId: { in: ids } } });
    await db.bag.deleteMany({ where: { studentId: { in: ids } } });
    await db.order.deleteMany({ where: { studentId: { in: ids } } });
    await db.notification.deleteMany({ where: { studentId: { in: ids } } });
    await db.student.deleteMany({ where: { id: { in: ids } } });
  }
  await db.college.deleteMany({ where: { id: { startsWith: TAG } } });
}

async function main() {
  console.log("\nFabricFold end-to-end check\n");
  await cleanup(); // clear anything a previous aborted run left behind

  // 1. A campus, closed on Sundays
  const college = await db.college.create({
    data: { id: TAG + "col", name: "E2E Test Campus", closedWeekday: 0, features: {} },
  });
  check("college created", !!college.id);

  // 2. New students get a wash day automatically, spread across the week
  const days: (number | null)[] = [];
  for (let i = 0; i < 6; i++) {
    const s = await db.student.create({
      data: { id: `${TAG}${i}`, phone: `9990000${String(i).padStart(3, "0")}`, name: `E2E Student ${i}`, collegeId: college.id },
    });
    await assignWashDay(s.id, college.id);
    const after = await db.student.findUniqueOrThrow({ where: { id: s.id }, select: { washDay: true } });
    days.push(after.washDay);
  }
  check("every new student got a wash day", days.every((d) => d !== null), days.map((d) => (d === null ? "-" : WEEKDAY_NAMES[d].slice(0, 3))).join(" "));
  check("nobody assigned to the campus closed day (Sun)", days.every((d) => d !== 0));
  check("load spread across more than one day", new Set(days).size > 1, `${new Set(days).size} distinct days`);

  // 3. Bag codes allocate, are well-formed, and never repeat
  const codes: string[] = [];
  for (const kind of ["bronze", "silver", "gold", "walkin"] as const) {
    const code = await db.$transaction((tx) => allocateBagCode(tx, kind));
    codes.push(code);
    const parsed = parseBagCode(code);
    check(`${kind} code well-formed`, !!parsed && parsed.kind === kind, code);
  }
  const second = await db.$transaction((tx) => allocateBagCode(tx, "bronze"));
  check("consecutive codes never repeat", second !== codes[0], `${codes[0]} then ${second}`);
  check("tier maps to kind", bagKindFor("gold") === "gold" && bagKindFor(null) === "walkin");

  // 4. A bag row persists, first one complimentary
  const bag = await db.bag.create({
    data: { code: codes[0], studentId: `${TAG}0`, tier: "bronze", complimentary: true, price: 0, issuedBy: "e2e" },
  });
  check("bag row written", bag.code === codes[0] && bag.complimentary === true);
  const dupe = await db.bag.create({ data: { code: codes[0], studentId: `${TAG}1`, issuedBy: "e2e" } })
    .then(() => true).catch(() => false);
  check("duplicate bag code rejected by the DB", dupe === false);

  // 5. Complaint with photo evidence + a linked free re-service
  const complaint = await db.complaint.create({
    data: {
      studentId: `${TAG}0`, collegeId: college.id, text: "E2E damage report",
      messages: { create: { from: "staff", by: "e2e", text: "Tear on sleeve", photos: ["intake/a.jpg", "intake/b.jpg", "intake/c.jpg"] } },
    },
    include: { messages: true },
  });
  const photos = complaint.messages[0].photos;
  check("complaint photos persisted as an array", Array.isArray(photos) && (photos as unknown[]).length === 3);
  check("message author recorded as staff", complaint.messages[0].from === "staff");

  await db.complaint.update({ where: { id: complaint.id }, data: { redoOrderId: "FF999999" } });
  const linked = await db.complaint.findUniqueOrThrow({ where: { id: complaint.id } });
  check("free re-service links back to the complaint", linked.redoOrderId === "FF999999");

  // 6. The retention sweep's query shape actually runs
  const { Prisma } = await import("../lib/generated/prisma/client");
  const retentionHits = await db.complaintMessage.count({
    where: { at: { lt: new Date(Date.now() + 86_400_000) }, photos: { not: Prisma.DbNull } },
  });
  check("retention query runs and sees photo rows", retentionHits >= 1, `${retentionHits} row(s)`);

  // 7. Collection-reminder counter defaults and increments
  const order = await db.order.create({
    data: {
      id: TAG + "ord1", studentId: `${TAG}0`, collegeId: college.id, service: "washIron",
      items: [{ label: "Regular garment", rate: 15, qty: 3 }], declaredPieces: 3,
      subtotal: 45, gst: 0, gstPctSnapshot: 0, total: 45, status: "ready",
    },
  });
  check("reminder counter defaults to 0", order.collectionRemindersSent === 0);
  const bumped = await db.order.update({ where: { id: order.id }, data: { collectionRemindersSent: { increment: 1 } } });
  check("reminder counter increments", bumped.collectionRemindersSent === 1);

  await cleanup();
  const leftover = await db.student.count({ where: { id: { startsWith: TAG } } });
  check("test data cleaned up", leftover === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exitCode = 1;
}

main()
  .catch(async (e) => { console.error("\nERROR:", e); await cleanup().catch(() => {}); process.exitCode = 1; })
  .finally(() => db.$disconnect());
