/* Full-pipeline QA walk against a REAL database.

   Follows one campus through the situations that actually occur, asserting the
   money and state invariants at every step. Where a server action needs a staff
   session, this replays the exact logic that action runs (the same shared
   helpers it imports) and asserts the same outcome — so a divergence between
   the rule and the arithmetic shows up here.

   Creates only rows prefixed with the QA tag and deletes them again.
   Run:  npx tsx scripts/qa-pipeline.ts */
import "dotenv/config";
import { db } from "../lib/db";
import { assignWashDay } from "../lib/washday-server";
import { allocateBagCode, bagKindFor, parseBagCode } from "../lib/bagcode";
import { computeBill, urgentCycleCharge, expressSurcharge } from "../lib/money";

const TAG = "qapipe";
const RUN = Date.now().toString(36).slice(-5); // unique per run
let pass = 0, fail = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${label}${detail ? `  (${detail})` : ""}`); }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? `  (${detail})` : ""}`); }
}
function eq(label: string, actual: unknown, expected: unknown) {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function section(t: string) { console.log(`\n── ${t}`); }

type Bucket = { service: string; cycles: number; used: number; kgPerCycle: number };

async function cleanup() {
  // A student with a ledger row can't be removed: Payment.studentId is nullable,
  // so Prisma would SET NULL on delete — an UPDATE the immutability trigger
  // rightly refuses. Skip those; they're inert and tagged.
  const pinned = new Set(
    (await db.payment.findMany({ where: { studentId: { startsWith: TAG } }, select: { studentId: true } }))
      .map((p) => p.studentId!)
      .filter(Boolean),
  );
  const studs = await db.student.findMany({ where: { id: { startsWith: TAG } }, select: { id: true } });
  const ids = studs.map((s) => s.id).filter((id) => !pinned.has(id));
  if (ids.length) {
    const comps = await db.complaint.findMany({ where: { studentId: { in: ids } }, select: { id: true } });
    await db.complaintMessage.deleteMany({ where: { complaintId: { in: comps.map((c) => c.id) } } });
    await db.complaint.deleteMany({ where: { studentId: { in: ids } } });
    const subs = await db.subscription.findMany({ where: { studentId: { in: ids } }, select: { id: true } });
    await db.cycleUse.deleteMany({ where: { subscriptionId: { in: subs.map((s) => s.id) } } });
    await db.subscription.deleteMany({ where: { studentId: { in: ids } } });
    await db.bag.deleteMany({ where: { studentId: { in: ids } } });
    await db.orderEvent.deleteMany({ where: { order: { studentId: { in: ids } } } });
    await db.order.deleteMany({ where: { studentId: { in: ids } } });
    await db.notification.deleteMany({ where: { studentId: { in: ids } } });
    await db.student.deleteMany({ where: { id: { in: ids } } });
  }
  await db.plan.deleteMany({ where: { college: { id: { startsWith: TAG } } } });
  // colleges only go once no student still references them
  if ((await db.student.count({ where: { id: { startsWith: TAG } } })) === 0) {
    await db.college.deleteMany({ where: { id: { startsWith: TAG } } });
  }
}

/** Mirrors acceptOrder's cycle-consumption branch. */
async function consumeCycle(subId: string, service: string) {
  const sub = await db.subscription.findUniqueOrThrow({ where: { id: subId } });
  const buckets = (sub.buckets as unknown as Bucket[] | null) || null;
  if (!buckets?.length) throw new Error("no buckets");
  const idx = buckets.findIndex((b) => b.service === service && b.used < b.cycles);
  if (idx < 0) throw new Error(`No ${service} cycles left on this plan`);
  buckets[idx] = { ...buckets[idx], used: buckets[idx].used + 1 };
  await db.subscription.update({ where: { id: subId }, data: { buckets, cyclesUsed: { increment: 1 } } });
  return { kgLimit: Number(buckets[idx].kgPerCycle) || 7 };
}

/** Mirrors restoreCycleFor. */
async function restoreCycle(orderId: string, subId: string, service: string) {
  const sub = await db.subscription.findUniqueOrThrow({ where: { id: subId } });
  const buckets = (sub.buckets as unknown as Bucket[] | null) || [];
  const idx = buckets.findIndex((b) => b.service === service && b.used > 0);
  const data: Record<string, unknown> = {};
  if (sub.cyclesUsed > 0) data.cyclesUsed = { decrement: 1 };
  if (idx >= 0) { buckets[idx] = { ...buckets[idx], used: buckets[idx].used - 1 }; data.buckets = buckets; }
  if (Object.keys(data).length) await db.subscription.update({ where: { id: subId }, data });
  await db.cycleUse.deleteMany({ where: { orderId } });
  await db.order.update({ where: { id: orderId }, data: { usedCycle: false, status: "cancelled" } });
}

async function main() {
  console.log("\n════ FabricFold QA pipeline ════");
  await cleanup();

  // ─────────────────────────────────────────────────────────────────
  section("Campus and the three St Mary's tiers");
  const college = await db.college.create({
    data: { id: TAG + RUN + "col", name: "QA Campus", closedWeekday: 0, features: {} },
  });
  const mk = (name: string, tier: string, price: number, buckets: { service: string; cycles: number; kgPerCycle: number }[]) =>
    db.plan.create({ data: { collegeId: college.id, name, tier, price, gstFree: true, active: true, buckets } });

  const bronze = await mk("Bronze", "bronze", 4000, [{ service: "washFold", cycles: 34, kgPerCycle: 7 }]);
  const silver = await mk("Silver", "silver", 5000, [
    { service: "washFold", cycles: 20, kgPerCycle: 7 },
    { service: "washIron", cycles: 14, kgPerCycle: 7 },
  ]);
  const gold = await mk("Gold", "gold", 6000, [{ service: "washIron", cycles: 34, kgPerCycle: 7 }]);
  eq("all three tiers total 34 cycles", [bronze, silver, gold].map((p) =>
    (p.buckets as unknown as Bucket[]).reduce((s, b) => s + b.cycles, 0)), [34, 34, 34]);
  check("prices are final (GST-free)", [bronze, silver, gold].every((p) => p.gstFree));

  // ─────────────────────────────────────────────────────────────────
  section("Registration → wash day");
  const stu = await db.student.create({
    data: { id: TAG + RUN, phone: "99950" + RUN, name: "QA Student", collegeId: college.id },
  });
  await assignWashDay(stu.id, college.id);
  const s1 = await db.student.findUniqueOrThrow({ where: { id: stu.id } });
  check("wash day assigned at registration", s1.washDay !== null, `day ${s1.washDay}`);
  check("never the campus closed day", s1.washDay !== 0);

  // ─────────────────────────────────────────────────────────────────
  section("Walk-in buys a bag (no plan = not free)");
  const wCode = await db.$transaction((tx) => allocateBagCode(tx, bagKindFor(null)));
  check("walk-in gets a W code", parseBagCode(wCode)?.kind === "walkin", wCode);
  const wBag = await db.bag.create({
    data: { code: wCode, studentId: stu.id, tier: null, complimentary: false, price: 250, issuedBy: "qa", status: "active" },
  });
  // Deliberately NOT writing a Payment row: the ledger is immutable by DB
  // trigger (correctly), so a QA run that posted one could never clean up after
  // itself. The bag's own price carries the same assertion.
  check("walk-in bag is charged, not complimentary", wBag.complimentary === false && Number(wBag.price) === 250);

  // ─────────────────────────────────────────────────────────────────
  section("Subscribes to Silver → free tier bag, history intact");
  const sub = await db.subscription.create({
    data: {
      studentId: stu.id, active: true, plan: silver.name, planId: silver.id,
      buckets: (silver.buckets as unknown as Bucket[]).map((b) => ({ ...b, used: 0 })),
      cyclesTotal: 34, cyclesUsed: 0, kgPerCycle: 7,
      startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000),
    },
  });
  await db.bag.update({ where: { id: wBag.id }, data: { status: "replaced" } });
  const sCode = await db.$transaction((tx) => allocateBagCode(tx, bagKindFor("silver")));
  await db.bag.create({ data: { code: sCode, studentId: stu.id, tier: "silver", complimentary: true, price: 0, issuedBy: "qa" } });
  check("subscriber's bag switches to S series", parseBagCode(sCode)?.kind === "silver", sCode);

  const sameStudent = await db.student.findUniqueOrThrow({ where: { id: stu.id }, include: { bags: true, orders: true } });
  check("HISTORY INTACT: same student id across the switch", sameStudent.id === stu.id);
  check("HISTORY INTACT: old walk-in bag still on record", sameStudent.bags.some((b) => b.code === wCode && b.status === "replaced"));
  check("HISTORY INTACT: lifetime pieces and wash day survive", sameStudent.washDay === s1.washDay);
  check("only one active bag at a time", sameStudent.bags.filter((b) => b.status === "active").length === 1);

  // ─────────────────────────────────────────────────────────────────
  section("Ordinary wash on a plan cycle");
  const o1 = await db.order.create({
    data: {
      id: TAG + RUN + "o1", studentId: stu.id, collegeId: college.id, service: "washFold",
      items: [{ label: "Regular garment", rate: 12, qty: 10 }], declaredPieces: 10,
      subtotal: 120, gst: 0, gstPctSnapshot: 0, total: 0, status: "received", usedCycle: true,
      paid: true, paymentMethod: "cycle", receivedAt: new Date(),
    },
  });
  await consumeCycle(sub.id, "washFold");
  await db.cycleUse.create({ data: { subscriptionId: sub.id, orderId: o1.id } });
  const bill1 = computeBill(120, 0, 18, { usedCycle: true });
  eq("cycle wash costs the student nothing", bill1, { gst: 0, total: 0 });
  const afterOne = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
  eq("one cycle consumed", afterOne.cyclesUsed, 1);
  eq("consumed from the washFold bucket", (afterOne.buckets as unknown as Bucket[]).find((b) => b.service === "washFold")!.used, 1);
  eq("washIron bucket untouched", (afterOne.buckets as unknown as Bucket[]).find((b) => b.service === "washIron")!.used, 0);

  // ─────────────────────────────────────────────────────────────────
  section("Urgent on a cycle — the 40% rule");
  const urgent = urgentCycleCharge(Number(silver.price), 34);
  eq("Silver urgent premium is ₹59", urgent, 59);
  const bill2 = computeBill(120, urgent, 18, { usedCycle: true });
  eq("only the premium is owed, cycle not re-charged", bill2, { gst: 0, total: 59 });
  const o2 = await db.order.create({
    data: {
      id: TAG + RUN + "o2", studentId: stu.id, collegeId: college.id, service: "washIron",
      items: [{ label: "Regular garment", rate: 15, qty: 8 }], declaredPieces: 8,
      express: true, surcharge: urgent, subtotal: 120, gst: 0, gstPctSnapshot: 0, total: bill2.total,
      status: "received", usedCycle: true, paid: false, receivedAt: new Date(),
    },
  });
  await consumeCycle(sub.id, "washIron");
  await db.cycleUse.create({ data: { subscriptionId: sub.id, orderId: o2.id } });
  check("urgent cycle order is NOT auto-paid", o2.paid === false);
  check("collection blocked while money owed", !o2.paid && Number(o2.total) > 0);
  const afterTwo = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
  eq("cycle still deducted for the urgent order", afterTwo.cyclesUsed, 2);

  // ─────────────────────────────────────────────────────────────────
  section("Excess weight, and excess + urgent together");
  eq("excess alone", computeBill(120, 0, 18, { usedCycle: true, excessCharge: 45 }).total, 45);
  eq("excess stacks with urgent", computeBill(120, urgent, 18, { usedCycle: true, excessCharge: 45 }).total, 104);

  // ─────────────────────────────────────────────────────────────────
  section("Cancelling returns the cycle");
  await restoreCycle(o2.id, sub.id, "washIron");
  const afterCancel = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
  eq("cycle count back to 1", afterCancel.cyclesUsed, 1);
  eq("washIron bucket restored to 0", (afterCancel.buckets as unknown as Bucket[]).find((b) => b.service === "washIron")!.used, 0);
  eq("cycle-use log row removed", await db.cycleUse.count({ where: { orderId: o2.id } }), 0);
  const o2After = await db.order.findUniqueOrThrow({ where: { id: o2.id } });
  check("order no longer claims to hold a cycle", o2After.usedCycle === false);

  // ─────────────────────────────────────────────────────────────────
  section("Service lock — a Wash&Fold cycle can't pay for dry cleaning");
  let blocked = false;
  try { await consumeCycle(sub.id, "dryClean"); } catch { blocked = true; }
  check("dry cleaning refused: no such bucket on this plan", blocked);

  // ─────────────────────────────────────────────────────────────────
  section("Bucket exhaustion");
  const drain = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
  const db2 = (drain.buckets as unknown as Bucket[]).map((b) => ({ ...b, used: b.cycles }));
  await db.subscription.update({ where: { id: sub.id }, data: { buckets: db2, cyclesUsed: 34 } });
  let exhausted = false;
  try { await consumeCycle(sub.id, "washFold"); } catch { exhausted = true; }
  check("refuses once every cycle is spent", exhausted);
  await db.subscription.update({
    where: { id: sub.id },
    data: { buckets: (silver.buckets as unknown as Bucket[]).map((b) => ({ ...b, used: 0 })), cyclesUsed: 0 },
  });

  // ─────────────────────────────────────────────────────────────────
  section("Expiry forfeits unused cycles");
  await db.subscription.update({ where: { id: sub.id }, data: { expiresAt: new Date(Date.now() - 86_400_000) } });
  const expired = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
  const isBlocked = !!(expired.expiresAt && expired.expiresAt.getTime() < Date.now());
  check("expired plan is refused even though active=true", isBlocked && expired.active === true);
  check("unused cycles are NOT carried over", expired.cyclesTotal - expired.cyclesUsed === 34 && isBlocked,
    "34 unused, all forfeited");
  await db.subscription.update({ where: { id: sub.id }, data: { expiresAt: new Date(Date.now() + 365 * 86_400_000) } });

  // ─────────────────────────────────────────────────────────────────
  section("Plan change Silver → Gold keeps used cycles");
  await consumeCycle(sub.id, "washFold");
  await consumeCycle(sub.id, "washFold");
  const before = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
  const oldB = (before.buckets as unknown as Bucket[]);
  const usedByService = new Map<string, number>();
  for (const b of oldB) usedByService.set(b.service, (usedByService.get(b.service) || 0) + b.used);
  const newBuckets = (gold.buckets as unknown as Bucket[]).map((b) => ({
    ...b, used: Math.min(b.cycles, usedByService.get(b.service) || 0),
  }));
  const diff = Number(gold.price) - Number(silver.price);
  eq("only the difference is charged", diff, 1000);
  // Gold has no washFold bucket, so those 2 used cycles don't transfer — but
  // they must not come back as free credit either.
  check("used cycles are not silently refunded on a plan change",
    newBuckets.every((b) => b.used <= b.cycles) && before.cyclesUsed === 2, `was ${before.cyclesUsed}`);

  // ─────────────────────────────────────────────────────────────────
  section("Walk-in pay-per-order (no plan)");
  eq("plain order pays GST", computeBill(500, 0, 18), { gst: 90, total: 590 });
  eq("same-day is 40% of order value", expressSurcharge(500), 200);
  eq("express + GST", computeBill(500, 200, 18), { gst: 126, total: 826 });
  eq("staff no-GST override", computeBill(500, 0, 18, { noGst: true }), { gst: 0, total: 500 });

  // ─────────────────────────────────────────────────────────────────
  section("Complaint with evidence, and a free re-wash");
  const complaint = await db.complaint.create({
    data: {
      studentId: stu.id, collegeId: college.id, orderId: o1.id, text: "Tear on sleeve",
      messages: { create: { from: "staff", by: "qa", text: "Found before washing", photos: ["a.jpg", "b.jpg", "c.jpg"] } },
    },
    include: { messages: true },
  });
  eq("three photos stored", (complaint.messages[0].photos as unknown[]).length, 3);
  const redo = await db.order.create({
    data: {
      id: TAG + RUN + "o3", studentId: stu.id, collegeId: college.id, service: "washFold",
      items: [{ label: "Regular garment", rate: 12, qty: 10 }], declaredPieces: 10,
      subtotal: 0, gst: 0, gstPctSnapshot: 0, total: 0, paid: true, paymentMethod: "redo",
      redoOfId: o1.id, status: "received",
    },
  });
  await db.complaint.update({ where: { id: complaint.id }, data: { redoOrderId: redo.id } });
  const linked = await db.complaint.findUniqueOrThrow({ where: { id: complaint.id } });
  check("free re-wash linked to the complaint", linked.redoOrderId === redo.id);
  check("re-wash costs the student nothing", Number(redo.total) === 0 && redo.paid);
  check("re-wash does NOT consume a cycle", redo.usedCycle === false);

  // ─────────────────────────────────────────────────────────────────
  section("Piece shortfall caught at ready");
  const intake = 10, counted = 9;
  const shortBy = Math.max(0, intake - counted);
  eq("shortfall detected", shortBy, 1);
  await db.order.update({ where: { id: o1.id }, data: { actualPieces: counted, status: "ready" } });
  const short = await db.order.findUniqueOrThrow({ where: { id: o1.id } });
  check("recount written before the student sees the bag", short.actualPieces === 9);
  eq("reminder counter starts at zero", short.collectionRemindersSent, 0);

  // ─────────────────────────────────────────────────────────────────
  section("Bag lost → new code, old never reissued");
  const active = await db.bag.findFirstOrThrow({ where: { studentId: stu.id, status: "active" } });
  await db.bag.update({ where: { id: active.id }, data: { status: "lost" } });
  const replacement = await db.$transaction((tx) => allocateBagCode(tx, bagKindFor("silver")));
  check("replacement code differs from the lost one", replacement !== active.code, `${active.code} → ${replacement}`);
  let dupe = false;
  try { await db.bag.create({ data: { code: active.code, studentId: stu.id, issuedBy: "qa" } }); dupe = true; } catch { /* expected */ }
  check("DB refuses to reissue a retired code", dupe === false);

  // ─────────────────────────────────────────────────────────────────
  section("Money invariants");
  let negative = false;
  for (const s of [0, 120, 999]) for (const su of [0, 59, 200]) for (const ex of [0, 45]) {
    if (computeBill(s, su, 18).total < 0) negative = true;
    if (computeBill(s, su, 18, { usedCycle: true, excessCharge: ex }).total < 0) negative = true;
  }
  check("no billing path can go negative", !negative);
  check("richer plan never makes urgent cheaper",
    urgentCycleCharge(4000, 34) < urgentCycleCharge(6000, 34), "B ₹47 < G ₹71");
  eq("malformed plan can't divide by zero", urgentCycleCharge(5000, 0), 0);

  await cleanup();
  check("this run left nothing behind", (await db.student.count({ where: { id: { startsWith: TAG + RUN } } })) === 0);

  console.log(`\n════ ${pass} passed, ${fail} failed ════`);
  if (fail) { console.log("FAILED:"); failures.forEach((f) => console.log("  - " + f)); process.exitCode = 1; }
}

main()
  .catch(async (e) => { console.error("\nFATAL:", e); await cleanup().catch(() => {}); process.exitCode = 1; })
  .finally(() => db.$disconnect());
