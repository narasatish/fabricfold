/* acceptOrder's double-accept race, exercised for REAL — not by reading
   source text. Found 2026-10-20 in a deep audit: acceptOrder read the
   order's status, checked `if (o.status !== "draft") throw`, then did a
   PLAIN, unconditional `tx.order.update` — no row lock, no `updateMany`
   scoped to the starting status. Every sibling status transition in this
   same file (collectOrder, advanceStatus, cancelOrder) was already fixed
   with exactly this gap; acceptOrder was missed. Two near-simultaneous
   accepts on the same draft order (a double-tap, a client retry, two
   counters opening the same pre-booked order) could both pass the stale
   check and both burn a subscription cycle for one physical order. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.98" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-accept-order-race.db");
const SCHEMA = "ff_accept_order_race";
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
        washIron: { label: "Wash & Iron", items: [["Cycle", 250]] },
        ironOnly: { label: "Iron Only", items: [["Garment", 15]] },
        dryClean: { label: "Dry Clean", items: [["Garment", 60]] },
      },
      payment: { upiId: "ff@test", payeeName: "Test", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });
  await db.college.create({ data: { id: "col1", name: "Accept Race College", features: {} } });
  const staff = await db.staff.create({ data: { phone: "9000000098", name: "Counter", role: 1, collegeId: "col1" } });
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
}, 300_000);

describe("acceptOrder can't be double-accepted under concurrency", () => {
  it("two concurrent accepts of the SAME draft order only burn one subscription cycle, not two", async () => {
    const stu = await db.student.create({ data: { id: "777777", phone: "9999900007", name: "Accept Racer", collegeId: "col1", credits: 0 } });
    await db.subscription.create({
      data: {
        studentId: stu.id, active: true, plan: "Bronze", cyclesTotal: 10, cyclesUsed: 0, kgPerCycle: 7,
        buckets: [{ service: "washFold", cycles: 10, used: 0, kgPerCycle: 7 }],
        startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000),
      },
    });
    const draft = await db.order.create({
      data: {
        id: "ARACE01", studentId: stu.id, collegeId: "col1", service: "washFold",
        items: [], declaredPieces: 0, cyclesCount: 1,
        subtotal: 0, gst: 0, gstPctSnapshot: 18, total: 0, status: "draft",
      },
    });

    const [r1, r2] = await Promise.all([
      orders.acceptOrder(draft.id, { weightKg: 5, useCycle: true, cycles: 1 }),
      orders.acceptOrder(draft.id, { weightKg: 5, useCycle: true, cycles: 1 }),
    ]);
    const results = [r1, r2];
    // Exactly one accept must win — the order is a single physical drop-off,
    // not two.
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(1);
    expect(results.find((r) => !r.ok)!.error).toMatch(/already received/i);

    const sub = await db.subscription.findUniqueOrThrow({ where: { studentId: stu.id } });
    // The bug this test targets would let BOTH accepts burn a cycle —
    // cyclesUsed landing at 2 instead of 1, and the bucket drifting from it.
    expect(sub.cyclesUsed).toBe(1);
    const buckets = sub.buckets as unknown as { service: string; used: number }[];
    expect(buckets.find((b) => b.service === "washFold")!.used).toBe(1);

    const cycleUses = await db.cycleUse.findMany({ where: { orderId: draft.id } });
    expect(cycleUses.length).toBe(1); // one row per cycle burned — not two

    const finalOrder = await db.order.findUniqueOrThrow({ where: { id: draft.id } });
    expect(finalOrder.status).toBe("received");
  });
});
