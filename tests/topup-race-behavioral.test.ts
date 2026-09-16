/* Behavioral test (real function calls, real test DB) for a gap found by
   code review 2026-09-16: topUpCredits (lib/actions/ops.ts) was the ONE
   money-writing action in that file with NO double-submission guard at
   all — clockIn, clockOut and closeDay in the very same file all lock/
   re-check inside their transaction, but a wallet top-up just did a bare
   $transaction with no duplicate check whatsoever. A double-tap (or a
   retried request on a flaky counter connection) would credit the wallet
   twice for cash tendered once. Fixed with an advisory lock + a short
   same-staff/same-params time-window check, since — unlike compensation,
   which got a real DB unique index — a top-up has no natural key: the same
   student legitimately tops up the same amount by the same method more
   than once in a day, so this test also proves a genuine repeat still
   works once the window passes. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.95" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_topup_race";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let opsActions: typeof import("../lib/actions/ops");
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

  db = (await import("../lib/db")).db;
  opsActions = await import("../lib/actions/ops");
  authLib = await import("../lib/auth");

  await db.college.create({ data: { id: "col1", name: "Topup Race College", features: {} } });
  await db.staff.create({ data: { id: "stf1", phone: "9000000010", name: "Counter One", role: 1, active: true, collegeId: "col1" } });
  await db.student.create({ data: { id: "stu1", phone: "9000000011", name: "Student One", collegeId: "col1", credits: 0 } });
}, 300_000);

async function signInAsStaff() {
  const st = await db.staff.findUniqueOrThrow({ where: { id: "stf1" } });
  await authLib.createSession({ mode: "staff", staffId: st.id, role: st.role, epoch: st.sessionEpoch });
}

describe("topUpCredits duplicate guard under real concurrency", () => {
  it("two genuinely concurrent identical top-ups credit the wallet only once", async () => {
    await signInAsStaff();

    const attempts = Array.from({ length: 2 }, () => opsActions.topUpCredits("stu1", 500, "cash"));
    const results = await Promise.all(attempts);

    const stu = await db.student.findUniqueOrThrow({ where: { id: "stu1" } });
    const payments = await db.payment.findMany({ where: { studentId: "stu1", note: "Wallet top-up" } });

    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(payments.length).toBe(1);
    expect(stu.credits.toNumber()).toBe(500);
  });

  it("a genuinely repeated top-up (same amount/method) still works once the window passes", async () => {
    await signInAsStaff();
    // Same student as above, already has 500 credits from the previous test —
    // continuing on the same row is deliberate: it proves the guard is a
    // short TIME window, not a permanent "never repeat this pair" rule.
    const before = await db.student.findUniqueOrThrow({ where: { id: "stu1" } });

    // Backdate the earlier Payment row past the 10s window instead of a real
    // sleep, so the test stays fast while still exercising "the window
    // expired" rather than "no prior top-up existed at all".
    await db.payment.updateMany({
      where: { studentId: "stu1", note: "Wallet top-up" },
      data: { at: new Date(Date.now() - 60_000) },
    });

    const r = await opsActions.topUpCredits("stu1", 500, "cash");
    expect(r.ok).toBe(true);

    const after = await db.student.findUniqueOrThrow({ where: { id: "stu1" } });
    expect(after.credits.toNumber()).toBe(before.credits.toNumber() + 500);
  });

  it("a DIFFERENT amount from the same staff member in the same instant is not blocked", async () => {
    await signInAsStaff();
    const before = await db.student.findUniqueOrThrow({ where: { id: "stu1" } });

    const [a, b] = await Promise.all([
      opsActions.topUpCredits("stu1", 200, "cash"),
      opsActions.topUpCredits("stu1", 300, "upi"),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const after = await db.student.findUniqueOrThrow({ where: { id: "stu1" } });
    expect(after.credits.toNumber()).toBe(before.credits.toNumber() + 500);
  });
});
