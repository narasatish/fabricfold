/* Found during a deep race/edge-case pass (2026-11-23): cancelSubscriptionRequest
   used a plain `db.subscription.delete()` on a subscription that's already
   pending-cancel (active: false). A SEQUENTIAL double-tap is harmless —
   requireStudent() re-reads fresh each call, so the second call's `stu.subscription`
   is already null and the delete is never reached. The real bug only
   surfaces under genuine concurrency: two near-simultaneous calls (two
   tabs, a flaky connection retrying while the first request is still in
   flight) both read the subscription as present via requireStudent()
   BEFORE either deletes it, both proceed into the delete block, and
   whichever call's `.delete()` runs second hits a row the first already
   removed, throwing an unhandled Prisma P2025. Fixed by switching to
   `deleteMany`, which matches zero rows silently — same pattern already
   used everywhere else in this codebase for a since-vanished row. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.211" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const SCHEMA = "ff_cancel_sub_dbltap";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let subscription: typeof import("../lib/actions/subscription");

let student: { id: string };

beforeAll(async () => {
  if (!IS_PG) throw new Error("This test needs a real Postgres DATABASE_URL/DIRECT_URL.");
  const { Client } = await import("pg");
  const client = new Client({ connectionString: BASE.split("?")[0] });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await client.end();
  execSync("npx prisma db push", {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  subscription = await import("../lib/actions/subscription");

  await db.college.create({ data: { id: "col1", name: "Test College", features: {} } });
  student = await db.student.create({ data: { id: "666666", phone: "9999900006", name: "Cancel Student", collegeId: "col1" } });
}, 300_000);

describe("cancelSubscriptionRequest is idempotent under a double-tap", () => {
  it("a sequential double-tap is already harmless (requireStudent re-reads fresh)", async () => {
    await db.subscription.create({
      data: { studentId: student.id, active: false, plan: "Monthly", cyclesTotal: 10, kgPerCycle: 5 },
    });
    await auth.createSession({ mode: "customer", studentId: student.id });

    const first = await subscription.cancelSubscriptionRequest();
    expect(first.ok).toBe(true);
    await expect(subscription.cancelSubscriptionRequest()).resolves.toEqual({ ok: true });

    const gone = await db.subscription.findUnique({ where: { studentId: student.id } });
    expect(gone).toBeNull();
  });

  it("two genuinely concurrent calls never throw, even when both read the row as present first", async () => {
    await db.subscription.create({
      data: { studentId: student.id, active: false, plan: "Monthly", cyclesTotal: 10, kgPerCycle: 5 },
    });
    await auth.createSession({ mode: "customer", studentId: student.id });

    // Real concurrency, same technique as this codebase's other race tests:
    // two in-flight calls, relying on actual network round trips to
    // Postgres to create the overlap window instead of mocking delays.
    const results = await Promise.allSettled([
      subscription.cancelSubscriptionRequest(),
      subscription.cancelSubscriptionRequest(),
    ]);
    for (const r of results) {
      expect(r.status).toBe("fulfilled");
      if (r.status === "fulfilled") expect(r.value).toEqual({ ok: true });
    }

    const gone = await db.subscription.findUnique({ where: { studentId: student.id } });
    expect(gone).toBeNull();
  });
});
