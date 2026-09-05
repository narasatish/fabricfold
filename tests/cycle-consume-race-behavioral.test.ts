/* Behavioral test (real function calls against a real test DB, not a
   source-regex check) for a race found 2026-09-05 during a deep audit:
   acceptOrder and walkInOrder burn a subscription's plan cycles by reading
   `buckets`, mutating one bucket's `used` count in memory, then writing the
   WHOLE buckets array back — with no row lock beforehand. Two orders racing
   on the same subscription (two counters, or a walk-in racing an app order)
   could both read the same "before" buckets snapshot, both pass the
   capacity check, and the second whole-array write would silently stomp the
   first order's bucket update: cyclesUsed (an atomic increment) stays
   numerically right, but the per-service bucket drifts from it and a plan
   could be over-drawn past its real remaining cycles. Fixed by locking the
   Subscription row and re-reading fresh, same pattern already used by
   restoreCycleFor/assignSubscription/sellCyclePack. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.97" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-cycle-consume-race.db");
const SCHEMA = "ff_cycle_consume_race";
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

  await db.college.create({ data: { id: "col1", name: "Race College", features: {} } });
  const staff = await db.staff.create({ data: { phone: "9000000096", name: "Counter", role: 1, collegeId: "col1" } });
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
}, 300_000);

async function mkStudentWithPlan(id: string, phone: string, totalCycles: number) {
  const stu = await db.student.create({ data: { id, phone, name: "Racer " + id, collegeId: "col1", credits: 0 } });
  const sub = await db.subscription.create({
    data: {
      studentId: id, active: true, plan: "Bronze", cyclesTotal: totalCycles, cyclesUsed: 0, kgPerCycle: 7,
      buckets: [{ service: "washFold", cycles: totalCycles, used: 0, kgPerCycle: 7 }],
      startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000),
    },
  });
  return { stu, sub };
}

describe("plan-cycle consumption can't be lost to a race between two orders", () => {
  it("two concurrent walkInOrder cycle burns on the same subscription both land in cyclesUsed AND in the bucket", async () => {
    await mkStudentWithPlan("444444", "9999900004", 10);

    const [r1, r2] = await Promise.all([
      orders.walkInOrder("444444", { service: "washFold", items: [], cycles: 2, weightKg: 5, useCycle: true }),
      orders.walkInOrder("444444", { service: "washFold", items: [], cycles: 3, weightKg: 5, useCycle: true }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    const sub = await db.subscription.findUniqueOrThrow({ where: { studentId: "444444" } });
    // 2 + 3 = 5 cycles burned total, no matter which order the transactions
    // actually serialized in — the bug this test targets would let the
    // bucket's `used` end up at only 2 or only 3 (whichever wrote last),
    // even though cyclesUsed (a separate atomic increment) already read 5.
    expect(sub.cyclesUsed).toBe(5);
    const buckets = sub.buckets as unknown as { service: string; used: number }[];
    const bucket = buckets.find((b) => b.service === "washFold")!;
    expect(bucket.used).toBe(5);
    expect(bucket.used).toBe(sub.cyclesUsed);
  });

  it("a bucket can't be over-drawn past its real remaining cycles under concurrency", async () => {
    await mkStudentWithPlan("555555", "9999900005", 5);

    // Two orders each asking for 3 cycles against a 5-cycle bucket: only one
    // can fit (3 + 3 = 6 > 5). The loser must be refused, not silently
    // allowed by racing past a stale capacity check.
    const [r1, r2] = await Promise.all([
      orders.walkInOrder("555555", { service: "washFold", items: [], cycles: 3, weightKg: 5, useCycle: true }),
      orders.walkInOrder("555555", { service: "washFold", items: [], cycles: 3, weightKg: 5, useCycle: true }),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(1);

    const sub = await db.subscription.findUniqueOrThrow({ where: { studentId: "555555" } });
    expect(sub.cyclesUsed).toBeLessThanOrEqual(5);
    expect(sub.cyclesUsed).toBe(3);
  });
});

describe("cancelOrder can't double-restore the same order's cycles under concurrency", () => {
  it("two concurrent cancelOrder calls on the same order only restore its cycles once", async () => {
    await mkStudentWithPlan("888888", "9999900008", 10);
    // Burn 4 cycles for real first, via walkInOrder, so cyclesUsed/bucket.used
    // start at a genuine 4 — then cancel that exact order twice at once.
    const placed = await orders.walkInOrder("888888", { service: "washFold", items: [], cycles: 4, weightKg: 5, useCycle: true });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;

    const before = await db.subscription.findUniqueOrThrow({ where: { studentId: "888888" } });
    expect(before.cyclesUsed).toBe(4);

    const [r1, r2] = await Promise.all([
      orders.cancelOrder(placed.id),
      orders.cancelOrder(placed.id),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(1);

    const after = await db.subscription.findUniqueOrThrow({ where: { studentId: "888888" } });
    // The bug this test targets would let the second, slower-to-lock cancel
    // re-read the ALREADY-restored balance and restore the same 4 cycles a
    // second time — cyclesUsed going negative-adjacent (0 - 4 clamped, or
    // worse, an over-restore past what was ever actually used). Correct
    // behavior: exactly the 4 burned cycles come back, once.
    expect(after.cyclesUsed).toBe(0);
    const buckets = after.buckets as unknown as { service: string; used: number }[];
    const bucket = buckets.find((b) => b.service === "washFold")!;
    expect(bucket.used).toBe(0);
  });
});
