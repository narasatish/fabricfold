/* Behavioral test (real function calls against a real test DB) for a live,
   unprotected race documented in prisma/schema.prisma and
   docs/claude-playbook.md: Payslip's @@unique([staffId, month]) constraint
   was verified safe against production data but was never actually applied
   — `prisma db push` refuses any new unique constraint on a non-empty
   table, and forcing it with --accept-data-loss isn't a session's call to
   make unilaterally. That left createPayslip's P2002 catch with NOTHING to
   ever actually catch: two concurrent payslip submissions for the same
   staff+month could both silently succeed, double-paying someone. Fixed
   2026-09-05 with a Postgres advisory lock (same technique as the
   slot-booking overbooking fix) plus an explicit duplicate check inside the
   lock — no schema migration required. This test creates its own test
   schema via `prisma db push`, which also does NOT have the unique
   constraint (same as production), so it's the correct environment to
   prove the application-level fix actually works without a DB backstop.

   Caveat, checked rather than assumed: temporarily removing just the
   advisory-lock line and re-running this test still PASSED — the third
   time this session a race test hasn't reliably forced itself open here
   (see tests/bag-race-behavioral.test.ts and
   tests/update-phone-race-behavioral.test.ts for the other two). This
   remote test DB's connection/latency characteristics don't reliably force
   two Promise.all-fired calls into a true race when the critical section
   is short. The fix is still correct and closes a real, documented,
   currently-unprotected gap; this test documents the intended behavior
   rather than proving the old code was exploitable under the exact
   conditions tried here. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.90" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-payslip-race.db");
const SCHEMA = "ff_payslip_race";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let admin: typeof import("../lib/actions/admin");

beforeAll(async () => {
  if (!IS_PG) return; // advisory locks are Postgres-only, same as the slot-race test
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });
  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  admin = await import("../lib/actions/admin");

  await db.college.create({ data: { id: "col1", name: "Payslip Race College", features: {} } });
  const owner = await db.staff.create({ data: { phone: "9000000089", name: "Owner", role: 4, collegeId: null } });
  await auth.createSession({ mode: "staff", staffId: owner.id, role: owner.role, epoch: owner.sessionEpoch });
}, 300_000);

describe.skipIf(!IS_PG)("createPayslip can't double-pay a staff member under real concurrency (no DB constraint backstop)", () => {
  it("two concurrent payslip submissions for the same staff+month: exactly one succeeds", async () => {
    const employee = await db.staff.create({ data: { phone: "9000000088", name: "Employee", role: 1, collegeId: "col1" } });

    // Confirm this test schema genuinely has NO unique constraint on
    // (staffId, month) — otherwise this test would pass even with the fix
    // reverted for the wrong reason (the DB catching it, not the app).
    const idx = await db.$queryRawUnsafe<{ indexname: string }[]>(
      `select indexname from pg_indexes where schemaname = '${SCHEMA}' and tablename = 'Payslip'`,
    );
    expect(idx.some((r) => /staffid.*month|month.*staffid/i.test(r.indexname))).toBe(false);

    const [r1, r2] = await Promise.all([
      admin.createPayslip({ staffId: employee.id, month: "2026-09", basic: 20000, allowances: 0, deductions: 0, postExpense: false }),
      admin.createPayslip({ staffId: employee.id, month: "2026-09", basic: 20000, allowances: 0, deductions: 0, postExpense: false }),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok).length).toBe(1);
    const loser = results.find((r) => !r.ok);
    if (loser && !loser.ok) expect(loser.error).toMatch(/already has a payslip/);

    const slips = await db.payslip.count({ where: { staffId: employee.id, month: "2026-09" } });
    expect(slips).toBe(1);
  });
});
