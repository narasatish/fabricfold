/* Behavioral test (real function calls against a real test DB, not a
   source-regex check) for an overbooking race found 2026-09-05:
   assertSlotBookable ran a bare `db.order.count` with no lock, called from
   placeOrder well BEFORE placeOrder's own `db.order.create` — two separate,
   unserialized round trips. N students booking a slot with exactly one seat
   left could all read the same "before" count, all pass the capacity check,
   and all create a draft order for it — silently exceeding the capacity the
   whole slot feature exists to enforce. Fixed with a Postgres advisory lock
   (SlotWindow rows are recurring weekly templates, not per-instance rows, so
   there is no physical row to SELECT ... FOR UPDATE) taken inside the SAME
   transaction that creates the order. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.92" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-slot-race.db");
const SCHEMA = "ff_slot_race";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let orders: typeof import("../lib/actions/orders");
let slots: typeof import("../lib/slots");

beforeAll(async () => {
  if (!IS_PG) {
    // Postgres-only fix (advisory locks are a Postgres feature) — skip the
    // whole file rather than fail when running against the sqlite fallback.
    return;
  }
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: BASE.split("?")[0] });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await admin.end();
  execSync("npx prisma db push", {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  orders = await import("../lib/actions/orders");
  slots = await import("../lib/slots");

  await db.appConfig.create({
    data: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: { washIron: { label: "Wash & Iron", items: [["Garment", 15]] } },
      payment: { upiId: "ff@test", payeeName: "Test", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });
  await db.college.create({ data: { id: "col1", name: "Slot Race College", features: {} } });
}, 300_000);

describe.skipIf(!IS_PG)("a drop-off slot can't be overbooked by concurrent placeOrder calls", () => {
  it("capacity 1: two concurrent bookings for the same slot leave exactly one order in it", async () => {
    // Tomorrow, IST — safely in the future relative to "now" so buildSlots
    // never excludes it as already-started, whatever time this test runs.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const weekday = slots.istWeekday(tomorrow);
    const dateStr = slots.istDateStr(tomorrow);
    const startMin = 600, endMin = 660; // 10:00–11:00 IST
    await db.slotWindow.create({ data: { collegeId: "col1", weekday, startMin, endMin, capacity: 1, active: true } });
    const startAtISO = slots.istInstant(dateStr, startMin).toISOString();

    const s1 = await db.student.create({ data: { id: "111101", phone: "9999901101", name: "Slot A", collegeId: "col1", credits: 0 } });
    const s2 = await db.student.create({ data: { id: "111102", phone: "9999901102", name: "Slot B", collegeId: "col1", credits: 0 } });

    async function placeAs(studentId: string) {
      cookieJar.clear();
      await auth.createSession({ mode: "customer", studentId, epoch: 0 });
      return orders.placeOrder({
        service: "washIron",
        items: [{ label: "Garment", qty: 3 }],
        express: false,
        dropSlotAt: startAtISO,
      });
    }

    const [r1, r2] = await Promise.all([placeAs(s1.id), placeAs(s2.id)]);
    const results = [r1, r2];
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    if (!failed[0].ok) expect(failed[0].error).toMatch(/filled up/);

    const booked = await db.order.count({
      where: { collegeId: "col1", dropSlotAt: new Date(startAtISO), status: { in: ["draft", "received"] } },
    });
    expect(booked).toBe(1);
  });
});
