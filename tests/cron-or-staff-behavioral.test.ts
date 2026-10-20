/* isCronOrStaff, exercised for REAL against a real staff session and a real
   test DB — not by reading source text. Found 2026-10-20 in a deep audit:
   seven routes with a staff-session fallback (purge-photos, error-digest,
   collection-reminders, stuck-orders, cron-watchdog, sheets/sync,
   sheets/flush) each had their OWN hand-rolled staff check —
   `getSession()` + `db.staff.findUnique` + a bare `role >= N` comparison —
   which never re-checked `active` or `sessionEpoch` against the DB at all.
   `requireStaff()` is the one place in this codebase meant to gate staff
   access specifically BECAUSE it re-checks both on every call — a
   deactivated staff member or "sign out everywhere" is supposed to take
   effect immediately, not at the 365-day session token's natural expiry.
   isCronOrStaff() now routes through requireStaff() instead of duplicating
   the weaker check, so it inherits that guarantee. This test proves it. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.92" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_cron_or_staff";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let cronAuth: typeof import("../lib/cron-auth");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });

  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  cronAuth = await import("../lib/cron-auth");

  await db.college.create({ data: { id: "col1", name: "Cron Auth College", features: {} } });
}, 300_000);

const fakeReq = () => new Request("https://x.test");

describe("isCronOrStaff re-checks session revocation, unlike the hand-rolled check it replaced", () => {
  it("accepts an active Owner session at the required role", async () => {
    const owner = await db.staff.create({ data: { phone: "9000000095", name: "Owner", role: 4, collegeId: "col1" } });
    await auth.createSession({ mode: "staff", staffId: owner.id, role: 4, epoch: owner.sessionEpoch });
    expect(await cronAuth.isCronOrStaff(fakeReq(), 4)).toBe(true);
  });

  it("refuses a session whose staff account has since been DEACTIVATED — the old check never caught this", async () => {
    const st = await db.staff.create({ data: { phone: "9000000096", name: "To Deactivate", role: 4, collegeId: "col1" } });
    await auth.createSession({ mode: "staff", staffId: st.id, role: 4, epoch: st.sessionEpoch });
    expect(await cronAuth.isCronOrStaff(fakeReq(), 4)).toBe(true); // still active — works

    await db.staff.update({ where: { id: st.id }, data: { active: false } });
    // Same cookie, same signature, same claimed role — only `active` changed
    // in the DB. The old hand-rolled check (role >= N only) would still
    // have said yes here; requireStaff()-backed isCronOrStaff must not.
    expect(await cronAuth.isCronOrStaff(fakeReq(), 4)).toBe(false);
  });

  it("refuses a session revoked by sessionEpoch bump — \"sign out everywhere\" must take effect immediately", async () => {
    const st = await db.staff.create({ data: { phone: "9000000097", name: "To Revoke", role: 4, collegeId: "col1" } });
    await auth.createSession({ mode: "staff", staffId: st.id, role: 4, epoch: st.sessionEpoch });
    expect(await cronAuth.isCronOrStaff(fakeReq(), 4)).toBe(true);

    await db.staff.update({ where: { id: st.id }, data: { sessionEpoch: { increment: 1 } } });
    // The cookie's embedded epoch is now stale — the old check never looked
    // at sessionEpoch at all and would still have accepted this.
    expect(await cronAuth.isCronOrStaff(fakeReq(), 4)).toBe(false);
  });

  it("refuses a role below the required minimum", async () => {
    const counter = await db.staff.create({ data: { phone: "9000000098", name: "Counter", role: 1, collegeId: "col1" } });
    await auth.createSession({ mode: "staff", staffId: counter.id, role: 1, epoch: counter.sessionEpoch });
    expect(await cronAuth.isCronOrStaff(fakeReq(), 4)).toBe(false);
  });

  it("refuses no session at all, and never throws", async () => {
    cookieJar.delete("ff_session");
    await expect(cronAuth.isCronOrStaff(fakeReq(), 1)).resolves.toBe(false);
  });

  it("still accepts the cron secret regardless of any staff session state", async () => {
    const original = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "test-secret-xyz";
    try {
      const req = new Request("https://x.test", { headers: { authorization: "Bearer test-secret-xyz" } });
      expect(await cronAuth.isCronOrStaff(req, 4)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = original;
    }
  });
});
