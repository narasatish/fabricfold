/* Behavioral test (real route handler invocation against a real test DB) for
   a gap found 2026-09-05: app/api/rt/route.ts (the SSE realtime stream) used
   bare getSession(), which only checks the cookie is validly signed — not
   that the account behind it can still sign in. Every other protected route
   re-derives active/epoch status from the database on every request
   (requireStaff/requireStudent), so a deactivated staff member or a
   "sign out everywhere" is locked out immediately. This route skipped that
   check: a fired staff member, or someone who killed their other sessions
   after a lost phone, could keep an already-open SSE connection alive
   indefinitely. Fixed by switching to liveSession(), which wraps the same
   revocation check requireStaff/requireStudent already do. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.85" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-rt-revocation.db");
const SCHEMA = "ff_rt_revocation";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let GET: () => Promise<Response>;

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
  const mod = await import("../app/api/rt/route");
  GET = mod.GET;

  await db.college.create({ data: { id: "col1", name: "RT Revocation College", features: {} } });
}, 300_000);

describe("the SSE realtime stream refuses a session whose account can no longer sign in", () => {
  it("a deactivated staff member's still-valid cookie is refused, not silently streamed to", async () => {
    const staff = await db.staff.create({ data: { phone: "9000000080", name: "Soon Fired", role: 1, collegeId: "col1", active: true } });
    await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });

    // Sanity: while still active, the connection is accepted.
    const okRes = await GET();
    expect(okRes.status).toBe(200);

    // Deactivated — same as setStaffActive(false) does in the real app.
    await db.staff.update({ where: { id: staff.id }, data: { active: false } });

    const revokedRes = await GET();
    expect(revokedRes.status).toBe(401);
  });

  it("a session whose epoch was bumped by 'sign out everywhere' is refused", async () => {
    const staff = await db.staff.create({ data: { phone: "9000000079", name: "Signs Out", role: 1, collegeId: "col1", active: true } });
    await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });

    const okRes = await GET();
    expect(okRes.status).toBe(200);

    // Bump the epoch — what signOutEverywhere/a role change does — without
    // touching the cookie already issued to this "browser".
    await db.staff.update({ where: { id: staff.id }, data: { sessionEpoch: { increment: 1 } } });

    const revokedRes = await GET();
    expect(revokedRes.status).toBe(401);
  });
});
