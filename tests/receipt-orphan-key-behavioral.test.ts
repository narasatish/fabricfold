/* Behavioral test (real route handler invocation against a real test DB) for
   an IDOR found 2026-09-05 in app/api/receipt/route.ts: the campus check was
   `if (expense) { assertSameCollege(...) }` — skipped ENTIRELY when no
   Expense row referenced the given key. An orphaned upload (the upload step
   succeeded but the Expense record was never created, or was later deleted)
   had no Expense row to match, so the campus check silently never ran and
   the file was servable to ANY staff member at ANY campus. The route's own
   comment says receipt keys are "not secret," which is exactly why this
   mattered. Fixed to fail closed: no matching Expense row now means a 404,
   never a bypass. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.86" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-receipt-orphan.db");
const SCHEMA = "ff_receipt_orphan";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let GET: (req: Request) => Promise<Response>;

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
  const mod = await import("../app/api/receipt/route");
  GET = mod.GET;

  await db.college.create({ data: { id: "colA", name: "Campus A", features: {} } });
  await db.college.create({ data: { id: "colB", name: "Campus B", features: {} } });
}, 300_000);

async function loginAsStaffAt(collegeId: string, phone: string) {
  const staff = await db.staff.create({ data: { phone, name: "Staff " + collegeId, role: 1, collegeId } });
  cookieJar.clear();
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
}

const get = (key: string) => GET(new Request(`https://fabricfold.in/api/receipt?key=${encodeURIComponent(key)}`));

describe("receipt view route fails closed on a key with no matching Expense row", () => {
  it("a key belonging to campus A's expense is refused to campus B staff (still enforced)", async () => {
    await db.expense.create({ data: { category: "Supplies", amount: 100, method: "cash", by: "x", collegeId: "colA", receiptKey: "receipts/real-key-a.jpg" } });
    await loginAsStaffAt("colB", "9000000081");
    const res = await get("receipts/real-key-a.jpg");
    expect(res.status).toBe(401);
  });

  it("a key with NO matching Expense row (orphaned upload) is refused with 404, not silently served to any staff", async () => {
    await loginAsStaffAt("colB", "9000000082");
    const res = await get("receipts/never-attached-to-any-expense.jpg");
    // Before the fix: this fell through the `if (expense)` guard and would
    // have attempted to serve/sign the file for ANY staff member — the bug.
    // After the fix: no Expense row to authorize against means refuse.
    expect(res.status).toBe(404);
  });
});
