/* Behavioral test (real function calls against a real test DB) for a bug
   found 2026-09-05: advanceStatus ran as a sequence of loose, unguarded
   db.xxx calls — no transaction, no atomic status check — unlike
   collectOrder and cancelOrder (both already fixed for exactly this shape
   of bug earlier the same day). Two concurrent calls for the same order (a
   double-tap, or two staff both advancing it) both read the same starting
   status, both compute the same next state, and both write it.
   "processing"->"ready" is the worse case: the pickup OTP is deleted and
   recreated with a FRESH random code on each call, and a pushNotif already
   went out to the student quoting the first call's now-invalidated code.
   Fixed with the same atomic updateMany + affected-count pattern
   collectOrder/cancelOrder already use. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.83" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-advance-status-race.db");
const SCHEMA = "ff_advance_status_race";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let orders: typeof import("../lib/actions/orders");

beforeAll(async () => {
  if (IS_PG) {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: BASE.split("?")[0] });
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await c.end();
    execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });
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
      rates: { ironOnly: { label: "Iron Only", items: [["Garment", 15]] } },
      payment: { upiId: "ff@test", payeeName: "Test", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });
  await db.college.create({ data: { id: "col1", name: "Advance Race College", features: {} } });
  const staff = await db.staff.create({ data: { phone: "9000000082", name: "Counter", role: 1, collegeId: "col1" } });
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
  await db.student.create({ data: { id: "444401", phone: "9999904401", name: "Race Student", collegeId: "col1", credits: 0 } });
}, 300_000);

describe("advanceStatus can't be double-applied by a concurrency race", () => {
  it("processing -> ready: two concurrent calls leave exactly one pickup OTP with one code, not a stale duplicate", async () => {
    const placed = await orders.walkInOrder("444401", { service: "ironOnly", items: [{ label: "Garment", qty: 3 }], weightKg: null, useCycle: false });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    // received -> processing first (sequential, just to get to the interesting state)
    const toProcessing = await orders.advanceStatus(placed.id);
    expect(toProcessing.ok).toBe(true);

    const [r1, r2] = await Promise.all([
      orders.advanceStatus(placed.id),
      orders.advanceStatus(placed.id),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(1);

    const otps = await db.otp.findMany({ where: { purpose: "pickup", refId: placed.id } });
    expect(otps.length).toBe(1);

    const finalOrder = await db.order.findUniqueOrThrow({ where: { id: placed.id } });
    expect(finalOrder.status).toBe("ready");
  });
});
