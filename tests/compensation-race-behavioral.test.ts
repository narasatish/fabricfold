/* Behavioral test (real function calls, real test DB) for a suspected gap
   found by code review 2026-09-16: submitCompensation's duplicate-guard is
   a plain findFirst() + create() inside a $transaction — but Postgres's
   default Read Committed isolation does NOT stop two concurrent
   transactions from both reading "no existing row" before either commits.
   Unlike every money-writing path this session has found protected by a
   real unique index (payment_gateway_ref_uniq, order_idem_key_uniq, ...),
   Compensation has no unique constraint backing this check at all — so a
   double-tap on the "Issue compensation" button is a plausible way to pay
   a student twice for the same complaint. This test proves it either way. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.94" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_comp_race";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let creditsActions: typeof import("../lib/actions/credits");
let authLib: typeof import("../lib/auth");

beforeAll(async () => {
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: BASE.split("?")[0] });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await admin.end();
  execSync("npx prisma db push", {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
  // Installs compensation_dupe_uniq (and the rest of ensure-guards.mjs) against
  // this isolated schema — without this, the DB-level backstop this test
  // exists to prove doesn't exist here, and the test would only be checking
  // the app-level findFirst, which is exactly the part known to race.
  execSync("node scripts/ensure-guards.mjs", {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: TEST_URL, DIRECT_URL: TEST_URL, FF_GUARD_SCHEMA: SCHEMA },
  });

  db = (await import("../lib/db")).db;
  creditsActions = await import("../lib/actions/credits");
  authLib = await import("../lib/auth");

  await db.college.create({ data: { id: "col1", name: "Comp Race College", features: {} } });
  await db.staff.create({ data: { id: "mgr1", phone: "9000000001", name: "Manager One", role: 2, active: true, collegeId: "col1" } });
  await db.student.create({ data: { id: "stu1", phone: "9000000002", name: "Student One", collegeId: "col1", credits: 0 } });
}, 300_000);

async function signInAsManager() {
  const st = await db.staff.findUniqueOrThrow({ where: { id: "mgr1" } });
  await authLib.createSession({ mode: "staff", staffId: st.id, role: st.role, epoch: st.sessionEpoch });
}

describe("submitCompensation duplicate guard under real concurrency", () => {
  it("two genuinely concurrent identical compensation submissions", async () => {
    await signInAsManager();

    const attempts = Array.from({ length: 2 }, () =>
      creditsActions.submitCompensation({
        studentId: "stu1",
        orderId: null,
        complaintId: "cmp1",
        kind: "goodwill",
        amount: 100,
        comment: "race test",
      }),
    );
    const results = await Promise.all(attempts);

    const rows = await db.compensation.findMany({ where: { studentId: "stu1", complaintId: "cmp1", kind: "goodwill" } });
    const stu = await db.student.findUniqueOrThrow({ where: { id: "stu1" } });

    // Exactly one of the two concurrent calls should have won — the other
    // should have hit either the app-level findFirst check or, if that raced,
    // the compensation_dupe_uniq index's P2002.
    expect(rows.length).toBe(1);
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(stu.credits.toNumber()).toBe(100);
  });
});
