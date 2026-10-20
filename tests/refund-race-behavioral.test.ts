/* refundOrder's over-refund cap, exercised for REAL — not by reading source
   text. Found by a deep hand-traced re-audit (Sep 2026): the cap check used
   to run entirely outside the transaction with no lock, so two concurrent
   refunds could both pass it before either committed. The regression tests
   in deep-audit-fixes.test.ts / order-races.test.ts only regex-match the
   fix's source code — they'd still pass if the lock had a typo, or if the
   write used the stale `o` instead of the freshly-locked read. This file
   actually calls refundOrder twice concurrently against a real test
   database and checks the final row, the only way to prove the race is
   actually closed. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.99" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-refund-race.db");
const SCHEMA = "ff_refund_race";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let orders: typeof import("../lib/actions/orders");

beforeAll(async () => {
  if (IS_PG) {
    const { Client } = await import("pg");
    const admin = new Client({ connectionString: BASE.split("?")[0] });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await admin.end();
    execSync("npx prisma db push", {
      cwd: path.resolve(__dirname, ".."), stdio: "ignore",
      env: { ...process.env, DATABASE_URL: TEST_URL },
    });
  } else {
    if (fs.existsSync(TEST_DB)) fs.rmSync(TEST_DB);
    execSync(`npx prisma db push --url "file:${TEST_DB}"`, { cwd: path.resolve(__dirname, ".."), stdio: "ignore" });
  }
  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  orders = await import("../lib/actions/orders");

  await db.college.create({ data: { id: "col1", name: "Test College", features: {} } });
  await db.student.create({ data: { id: "111111", phone: "9999900001", name: "Test Student", collegeId: "col1", credits: 0 } });
  const staff = await db.staff.create({ data: { phone: "9000000099", name: "Manager", role: 2, collegeId: "col1" } });
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
}, 300_000);

function mkPaidOrder(id: string, total: number) {
  return db.order.create({
    data: {
      id, studentId: "111111", collegeId: "col1", service: "washIron",
      items: [{ label: "Regular garment", rate: 15, qty: 10 }],
      subtotal: Math.round(total / 1.18), gst: total - Math.round(total / 1.18), gstPctSnapshot: 18, total,
      paid: true, paymentMethod: "upi",
    },
  });
}

describe("refundOrder can't be over-refunded by two concurrent calls (real, not source-regex)", () => {
  it("caps total refunds at the order's total even when two refunds race", async () => {
    await mkPaidOrder("RRACE01", 500);

    const [r1, r2] = await Promise.all([
      orders.refundOrder("RRACE01", 400, "cash", "test race A"),
      orders.refundOrder("RRACE01", 400, "cash", "test race B"),
    ]);

    // Exactly one of the two ₹400 refunds must have been accepted — both
    // together (₹800) exceed the ₹500 order total, so the second one to
    // reach the lock must see the fresh, already-updated refundAmount and
    // be refused.
    const results = [r1, r2];
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    expect(failed[0].error).toMatch(/Only ₹100 left to refund|already been fully refunded/);

    const final = await db.order.findUniqueOrThrow({ where: { id: "RRACE01" } });
    expect(Number(final.refundAmount)).toBeLessThanOrEqual(500);
    expect(Number(final.refundAmount)).toBe(400);

    const refundPayments = await db.payment.findMany({ where: { orderId: "RRACE01", method: "refund" } });
    expect(refundPayments.length).toBe(1);
  });

  it("a third refund attempt after the cap is reached is cleanly refused, not allowed to push the total over", async () => {
    await mkPaidOrder("RRACE02", 300);
    const first = await orders.refundOrder("RRACE02", 300, "cash", "full refund");
    expect(first.ok).toBe(true);

    const second = await orders.refundOrder("RRACE02", 1, "cash", "should be refused");
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already been fully refunded/);

    const final = await db.order.findUniqueOrThrow({ where: { id: "RRACE02" } });
    expect(Number(final.refundAmount)).toBe(300);
  });

  /* Found 2026-10-20 in a deep audit: the refund AMOUNT cap (above) was
     already correctly protected by the Order row lock, but restoreCycleFor's
     own precondition check (`if (!ord.usedCycle...)`) was handed the STALE
     pre-transaction order snapshot, not the locked fresh read — so two
     concurrent refunds with restoreCycle=true, each well under the rupee
     cap, could BOTH see usedCycle=true and both decrement the subscription,
     double-crediting one real cycle burn. This is deliberately a scenario
     where the rupee cap does NOT reject either call (small amounts), so a
     test that only checks refundAmount/payment-row-count (like the ones
     above) would not have caught this at all — only checking cyclesUsed
     does. */
  it("can't double-restore a subscription cycle when two small concurrent refunds both ask to restore it", async () => {
    // cyclesUsed starts at 2, as if a SECOND, untouched order elsewhere also
    // burned a cycle — deliberately NOT 1, so a double-restore shows up as a
    // wrong final count (1, i.e. only this order's cycle restored) vs. the
    // buggy outcome (0, i.e. restored twice) rather than both landing on 0
    // via the decrement's own negative-clamp, which would mask the bug.
    const sub = await db.subscription.create({
      data: {
        studentId: "111111", active: true, plan: "Bronze", cyclesTotal: 10, cyclesUsed: 2, kgPerCycle: 7,
        buckets: [{ service: "washFold", cycles: 10, used: 2, kgPerCycle: 7 }],
        startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000),
      },
    });
    await db.order.create({
      data: {
        id: "RRACE03", studentId: "111111", collegeId: "col1", service: "washFold",
        items: [{ label: "Cycle", rate: 200, qty: 1 }], cyclesCount: 1,
        subtotal: 200, gst: 0, gstPctSnapshot: 18, total: 200,
        paid: true, paymentMethod: "cash", usedCycle: true,
      },
    });
    await db.cycleUse.create({ data: { subscriptionId: sub.id, orderId: "RRACE03" } });

    // ₹50 + ₹50 = ₹100, well under the ₹200 order total — the amount cap
    // alone would let both through. Only the usedCycle fix stops the second
    // one from also restoring a cycle.
    const [r1, r2] = await Promise.all([
      orders.refundOrder("RRACE03", 50, "cash", "partial A", true),
      orders.refundOrder("RRACE03", 50, "cash", "partial B", true),
    ]);
    expect([r1, r2].filter((r) => r.ok).length).toBe(2); // both refunds themselves are valid and independent

    const subAfter = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    // Restored exactly once: 2 -> 1, not 2 -> 0 (which is what two restores
    // of this order's single cycle would wrongly produce).
    expect(subAfter.cyclesUsed).toBe(1);
    const buckets = subAfter.buckets as unknown as { service: string; used: number }[];
    expect(buckets.find((b) => b.service === "washFold")!.used).toBe(1);
    const cycleUses = await db.cycleUse.findMany({ where: { orderId: "RRACE03" } });
    expect(cycleUses.length).toBe(0); // deleted once, not double-deleted/erroring
    const orderAfter = await db.order.findUniqueOrThrow({ where: { id: "RRACE03" } });
    expect(orderAfter.usedCycle).toBe(false);
  });
});
