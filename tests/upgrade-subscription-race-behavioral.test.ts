/* upgradeSubscription's money, exercised for REAL — not by reading source
   text. Found 2026-10-20 in a deep audit: the buckets/cycles math was
   correctly rebuilt from a fresh, locked read inside the transaction, but
   the PAYMENT amount (`difference`) was computed once, before the
   transaction, from the pre-transaction `cur` snapshot, and used unchanged.

   Two concurrent upgrades for the same student targeting DIFFERENT
   destination plans (two counters/Managers — not a same-plan double-tap,
   which was already caught by the planId re-check) both read the same
   starting plan before either committed. The second call's fresh read
   correctly saw the first upgrade's new plan already applied for the
   CYCLES math, but the stale `difference` closure still charged
   (secondPlan − originalPlan) instead of (secondPlan − firstUpgradePlan) —
   overcharging by exactly the first upgrade's own price, already paid once. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.93" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_upgrade_sub_race";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let sub: typeof import("../lib/actions/subscription");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });

  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  sub = await import("../lib/actions/subscription");

  await db.appConfig.create({
    data: {
      id: "main", gstPct: 0, // GST-free plans keep the arithmetic exact for this test
      plan: { price: 1000, cycles: 10, kgPerCycle: 7 },
      rates: { washFold: { label: "Wash & Fold", items: [["Cycle", 200]] } },
      payment: { upiId: "ff@test", payeeName: "Test", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });
  await db.college.create({ data: { id: "col1", name: "Upgrade Race College", features: {} } });
  const staff = await db.staff.create({ data: { phone: "9000000094", name: "Manager", role: 2, collegeId: "col1" } });
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
}, 300_000);

describe("upgradeSubscription charges the right amount when two concurrent upgrades target DIFFERENT plans", () => {
  it("never overcharges by double-counting the first upgrade's own price", async () => {
    const planA = await db.plan.create({ data: { name: "A", price: 1000, tier: "bronze", collegeId: "col1", active: true, buckets: [{ service: "washFold", cycles: 10, kgPerCycle: 7 }] } });
    const planB = await db.plan.create({ data: { name: "B", price: 1200, tier: "silver", collegeId: "col1", active: true, buckets: [{ service: "washFold", cycles: 15, kgPerCycle: 7 }] } });
    const planC = await db.plan.create({ data: { name: "C", price: 1300, tier: "gold", collegeId: "col1", active: true, buckets: [{ service: "washFold", cycles: 20, kgPerCycle: 7 }] } });

    const stu = await db.student.create({ data: { id: "994501", phone: "9994500001", name: "Upgrade Racer", collegeId: "col1", credits: 0 } });
    await db.subscription.create({
      data: {
        studentId: stu.id, active: true, plan: planA.name, planId: planA.id,
        buckets: [{ service: "washFold", cycles: 10, used: 0, kgPerCycle: 7 }],
        cyclesTotal: 10, cyclesUsed: 0, kgPerCycle: 7,
        startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000),
      },
    });

    // Both calls race from the SAME starting point (Plan A, ₹1000), one
    // targeting B (₹1200), the other C (₹1300). Postgres serializes them on
    // the Subscription row lock; whichever gets the lock first upgrades
    // A->B or A->C for ₹200/₹300 respectively, and the SECOND call must see
    // the first's new plan and charge only the remaining difference to
    // reach its own target — not double-count the leg already paid.
    const [r1, r2] = await Promise.all([
      sub.upgradeSubscription(stu.id, planB.id, "cash"),
      sub.upgradeSubscription(stu.id, planC.id, "cash"),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok).length).toBe(2); // both legitimately succeed — serialized, not conflicting

    const payments = await db.payment.findMany({ where: { studentId: stu.id }, orderBy: { at: "asc" } });
    const totalCharged = payments.reduce((s, p) => s + Number(p.amount), 0);
    const finalSub = await db.subscription.findUniqueOrThrow({ where: { studentId: stu.id } });

    // Whichever order the two calls actually serialized in, ending on
    // Plan C from a Plan A start must total exactly C's price minus A's —
    // ₹1300 − ₹1000 = ₹300. The bug this test targets would total ₹500
    // (₹200 for A->B, then a stale ₹300 = C−A again for the second call
    // instead of the correct ₹100 = C−B), double-counting the A->B leg.
    expect([planB.id, planC.id]).toContain(finalSub.planId);
    const finalPlanPrice = finalSub.planId === planC.id ? 1300 : 1200;
    expect(totalCharged).toBe(finalPlanPrice - 1000);
  });
});
