/* payOrder/recordPay/the Razorpay webhook all settle an order against its
   CURRENT `total` — but `total` is not final until acceptOrder (staff
   weighing/receiving) runs. Before that, an order sits in "draft" with only
   an estimated total from the student's own declared items.

   Nothing stopped a student (or a replayed/retried request) from paying a
   draft order — via credits, via the gateway, or the webhook racing ahead of
   a slow client — using payOrder/createGatewayOrder/confirmGatewayPayment,
   none of which checked order.status. acceptOrder, run afterwards by staff,
   recomputes `total` from the ACTUAL weight/items and had no idea the order
   was already marked paid — it just overwrites `total` unconditionally.

   Net effect: an order can show `paid: true` / "Paid via credit" while its
   final total is higher than what was ever actually collected — the
   difference is just gone, with no error, no record, nothing to reconcile
   against. This is exercised for real against a live Postgres test schema,
   not by reading source text. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.201" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-pay-before-accept.db");
const SCHEMA = "ff_pay_before_accept";
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

  await db.appConfig.create({
    data: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: {
        washFold: { label: "Wash & Fold", items: [["Cycle", 200]] },
        washIron: { label: "Wash & Iron", items: [["Garment", 10]] },
        ironOnly: { label: "Iron Only", items: [["Garment", 15]] },
        dryClean: { label: "Dry Clean", items: [["Garment", 60]] },
      },
      payment: { upiId: "ff@test", payeeName: "Test", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });
  await db.college.create({ data: { id: "col1", name: "Test College", features: {} } });
  await db.student.create({ data: { id: "222222", phone: "9999900002", name: "Draft Student", collegeId: "col1", credits: 1000 } });
  const staff = await db.staff.create({ data: { phone: "9000000098", name: "Counter", role: 1, collegeId: "col1" } });

  (globalThis as unknown as { __staff: typeof staff }).__staff = staff;
}, 300_000);

function mkDraftOrder(id: string, total: number) {
  return db.order.create({
    data: {
      id, studentId: "222222", collegeId: "col1", service: "washIron",
      items: [{ label: "Garment", rate: 10, qty: 10 }],
      declaredPieces: 10,
      subtotal: total, gst: 0, gstPctSnapshot: 0, total,
      status: "draft",
    },
  });
}

describe("a draft order can't be settled against a total that isn't final yet", () => {
  it("pays the draft with credits, then acceptOrder re-weighs to a HIGHER total — the paid order must not silently absorb the gap", async () => {
    const stu = await db.student.findUniqueOrThrow({ where: { id: "222222" } });
    await auth.createSession({ mode: "customer", studentId: stu.id, epoch: stu.sessionEpoch });

    await mkDraftOrder("DRAFT01", 100);

    const payResult = await orders.payOrder("DRAFT01", "upi", true);
    // The fix: a draft order isn't payable yet.
    expect(payResult.ok).toBe(false);

    const staff = (globalThis as unknown as { __staff: { id: string; role: number; sessionEpoch: number } }).__staff;
    await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });

    // Staff now receives/weighs the order for real — the actual pieces are
    // MORE than declared, so the final total is higher than the estimate.
    const acceptResult = await orders.acceptOrder("DRAFT01", {
      weightKg: 4, useCycle: false,
      items: [{ label: "Garment", qty: 20 }],
    });
    expect(acceptResult.ok).toBe(true);

    const final = await db.order.findUniqueOrThrow({ where: { id: "DRAFT01" } });
    // The order must NOT have been marked paid off the stale ₹100 estimate —
    // whatever actually happened, `paid` and `total` must stay consistent:
    // either it's unpaid (the draft payment was correctly rejected above and
    // this is simply the normal post-accept state), or if it is paid, the
    // amount actually collected must cover the final total.
    if (final.paid) {
      const collected = await db.payment.aggregate({
        where: { orderId: "DRAFT01", method: { notIn: ["refund", "cash_out"] } },
        _sum: { amount: true },
      });
      expect(Number(collected._sum.amount || 0)).toBeGreaterThanOrEqual(Number(final.total));
    }
  });
});
