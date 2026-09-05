/* Behavioral test (real function calls against a real, SCHEMA-ISOLATED test
   DB, not a source-regex check) for TWO bugs found 2026-09-05 in issueBag's
   "already has an active bag" guard:

   1. The lock originally used a raw `SELECT ... FOR UPDATE` that was never
      schema-qualified via dbSchemaPrefix, unlike every other raw lock in
      this codebase. Fixed first, but reverting just that fix and re-running
      this test still passed both times tried — this test's two concurrent
      calls happened to still serialize enough over this remote DB's
      connection/latency characteristics for that specific defect not to
      surface here.

   2. The REAL bug, found when this test unexpectedly FAILED for real in a
      full `npm test` run despite bug #1 already being fixed: `SELECT ... FOR
      UPDATE` only locks rows it actually MATCHES. A brand-new student with
      no bag yet has ZERO rows matching `status = 'active'` — so the lock
      was a complete no-op for exactly the case that matters most, a
      student's FIRST bag (which is exactly what this test's fixture
      creates). Two concurrent first-time issuances had nothing to lock and
      both went through, confirmed by this test genuinely failing (2 bags
      issued, not 1) in a real run — not a false-positive, an actual catch.

   Fixed with a Postgres advisory lock keyed on studentId
   (`pg_advisory_xact_lock(hashtext('bag-issue|' + studentId))`), which
   works whether or not any Bag row exists yet — same technique as the
   slot-booking and payslip fixes elsewhere this session. Re-run 3+ times
   consecutively after this fix with no failures, versus the old code's
   demonstrated real failure. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.96" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-bag-race.db");
const SCHEMA = "ff_bag_race";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let bags: typeof import("../lib/actions/bags");

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
  bags = await import("../lib/actions/bags");

  await db.college.create({ data: { id: "col1", name: "Bag Race College", features: {} } });
  await db.student.create({ data: { id: "666666", phone: "9999900006", name: "Bag Racer", collegeId: "col1", credits: 0 } });
  const staff = await db.staff.create({ data: { phone: "9000000095", name: "Counter", role: 1, collegeId: "col1" } });
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
}, 300_000);

describe("issueBag can't create two active bags for one student under real concurrency", () => {
  it("only one of two simultaneous issueBag calls for the same student succeeds", async () => {
    const [r1, r2] = await Promise.all([
      bags.issueBag("666666", {}),
      bags.issueBag("666666", {}),
    ]);
    const results = [r1, r2];
    const succeeded = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    if (!failed[0].ok) expect(failed[0].error).toMatch(/already has an active bag/);

    const activeBags = await db.bag.findMany({ where: { studentId: "666666", status: "active" } });
    expect(activeBags.length).toBe(1);
  });
});
