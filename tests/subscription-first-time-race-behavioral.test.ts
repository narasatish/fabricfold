/* Behavioral test (real function calls against a real test DB) for a bug
   found 2026-09-05: assignSubscription and sellCyclePack both locked with
   `SELECT ... FOR UPDATE WHERE studentId = X` before writing a student's
   Subscription row — but for a student's FIRST-EVER plan or cycle pack,
   there is NO Subscription row yet, so the WHERE clause matches zero rows
   and the lock holds nothing. Two concurrent calls for the same first-time
   student both read "no existing subscription," both compute a fresh
   buckets array, and both still charge the student (a Payment row, or a
   credits decrement) even though the upsert's create-then-update sequence
   leaves only ONE purchase's cycles in the final row — a real double-charge
   with silently discarded cycles.

   This is the exact same root-cause bug independently found in issueBag's
   "student's first bag" case (tests/bag-race-behavioral.test.ts) — a plain
   row lock cannot protect a row that doesn't exist yet. Fixed the same way:
   a Postgres advisory lock keyed on studentId, which works regardless of
   whether the Subscription row exists. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.89" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-sub-first-race.db");
const SCHEMA = "ff_sub_first_race";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let sub: typeof import("../lib/actions/subscription");

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
  sub = await import("../lib/actions/subscription");

  await db.appConfig.create({
    data: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: { washFold: { label: "Wash & Fold", items: [["Cycle", 200]] } },
      payment: { upiId: "ff@test", payeeName: "Test", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });
  await db.college.create({ data: { id: "col1", name: "First-Time Race College", features: {} } });
  const staff = await db.staff.create({ data: { phone: "9000000087", name: "Manager", role: 2, collegeId: "col1" } });
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
}, 300_000);

describe("a student's FIRST subscription/pack can't be double-charged by a concurrency race", () => {
  it("assignSubscription: two concurrent first-time assigns for the same student — exactly one succeeds", async () => {
    await db.student.create({ data: { id: "333301", phone: "9999903301", name: "First Plan", collegeId: "col1", credits: 0 } });
    const plan = await db.plan.create({
      data: { collegeId: "col1", name: "Bronze", price: 5000, buckets: [{ service: "washFold", cycles: 20, kgPerCycle: 7 }] },
    });

    const [r1, r2] = await Promise.all([
      sub.assignSubscription("333301", plan.id, "cash"),
      sub.assignSubscription("333301", plan.id, "cash"),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(1);

    // Only ONE plan payment should have been recorded, not two.
    const payments = await db.payment.count({ where: { studentId: "333301", note: { contains: "Subscription" } } });
    expect(payments).toBe(1);
  });

  it("sellCyclePack: two concurrent first-ever packs for the same student — cycles from BOTH must land, not be silently discarded", async () => {
    await db.student.create({ data: { id: "333302", phone: "9999903302", name: "First Pack", collegeId: "col1", credits: 0 } });

    const [r1, r2] = await Promise.all([
      sub.sellCyclePack("333302", { service: "washFold", cycles: 5, method: "cash" }),
      sub.sellCyclePack("333302", { service: "washFold", cycles: 7, method: "cash" }),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Both purchases charged (2 cash payments expected — that's correct,
    // they're two real separate top-ups) AND both purchases' cycles must be
    // reflected in the final bucket — 5 + 7 = 12, not just whichever
    // transaction's upsert happened to write last.
    const payments = await db.payment.count({ where: { studentId: "333302", note: { contains: "Cycle pack" } } });
    expect(payments).toBe(2);

    const subRow = await db.subscription.findUniqueOrThrow({ where: { studentId: "333302" } });
    const buckets = subRow.buckets as unknown as { service: string; cycles: number }[];
    const bucket = buckets.find((b) => b.service === "washFold")!;
    expect(bucket.cycles).toBe(12);
    expect(subRow.cyclesTotal).toBe(12);
  });
});
