/* confirmGatewayPayment (lib/actions/payments.ts) verifies that
   `rzp.signature` is a genuine HMAC(rzpOrderId|paymentId) from Razorpay —
   proof that SOME payment was captured — but never checks that the
   Razorpay order it refers to was actually the one createGatewayOrder made
   for the internal order being paid. There is nowhere in the schema that
   records which rzpOrderId belongs to which internal Order.

   Net effect: a student can run createGatewayOrder/checkout on a CHEAP
   order of their own, get Razorpay's real signature for that genuine small
   payment, and then call confirmGatewayPayment again with a DIFFERENT
   (expensive) order id of their own but the same real rzpOrderId/paymentId/
   signature triple. The signature check passes — it only proves the triple
   is internally consistent, not that it was ever paid against THIS order —
   and the expensive order is marked fully paid for the price of the cheap
   one.

   Exercised against a live Postgres test schema, not by reading source. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.202" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-gateway-crossorder.db");
const SCHEMA = "ff_gateway_crossorder";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;
process.env.RAZORPAY_KEY_ID = "rzp_test_key";
process.env.RAZORPAY_KEY_SECRET = "rzp_test_secret";

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let payments: typeof import("../lib/actions/payments");

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
  payments = await import("../lib/actions/payments");

  await db.appConfig.create({
    data: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: { washIron: { label: "Wash & Iron", items: [["Garment", 10]] } },
      payment: { upiId: "ff@test", payeeName: "Test", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });
  await db.college.create({ data: { id: "col1", name: "Test College", features: { gateway: true } } });
  await db.student.create({ data: { id: "222222", phone: "9999900002", name: "Gateway Student", collegeId: "col1" } });
}, 300_000);

function mkOrder(id: string, total: number) {
  return db.order.create({
    data: {
      id, studentId: "222222", collegeId: "col1", service: "washIron",
      items: [{ label: "Garment", rate: 10, qty: 10 }],
      subtotal: total, gst: 0, gstPctSnapshot: 0, total,
      status: "received",
    },
  });
}

describe("gateway signature is tied to a specific internal order", () => {
  it("a valid signature from a CHEAP order's own payment cannot be replayed to pay off a different, expensive order", async () => {
    const stu = await db.student.findUniqueOrThrow({ where: { id: "222222" } });
    await auth.createSession({ mode: "customer", studentId: stu.id, epoch: stu.sessionEpoch });

    await mkOrder("CHEAP01", 1);
    await mkOrder("EXP0001", 5000);

    // Student genuinely starts paying the ₹1 order — createGatewayOrder asks
    // Razorpay to create an order (mocked below, since we have no real key).
    const fakeRzpOrderId = "order_REAL123";
    const origFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ id: fakeRzpOrderId, amount: 100 }), { status: 200 })
    ) as typeof fetch;
    const created = await payments.createGatewayOrder("CHEAP01", false);
    global.fetch = origFetch;
    expect(created.ok).toBe(true);

    // Razorpay genuinely captures that ₹1 payment; this is the REAL signature
    // Razorpay's own checkout would hand back for THIS rzpOrderId/paymentId.
    const paymentId = "pay_REAL123";
    const signature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET!)
      .update(`${fakeRzpOrderId}|${paymentId}`)
      .digest("hex");

    // Attacker (the same student) now uses that genuine triple against the
    // EXPENSIVE order instead of the cheap one it was actually issued for.
    const result = await payments.confirmGatewayPayment("EXP0001", false, {
      orderId: fakeRzpOrderId,
      paymentId,
      signature,
    });

    expect(result.ok).toBe(false);

    const exp = await db.order.findUniqueOrThrow({ where: { id: "EXP0001" } });
    expect(exp.paid).toBe(false);
  });
});
