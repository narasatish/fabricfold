/* Behavioral test (real function calls against a real test DB) for a gap
   found 2026-09-05: updateStudentPhone had the same TOCTOU registerStudent
   was already fixed for — the "is this number free" check ran before the
   write, with no try/catch around the write itself. Two concurrent
   phone-change requests landing on the same new number would both pass the
   check, and the second write would hit the unique constraint on `phone`
   and throw UNHANDLED — a raw 500 instead of the friendly message the
   sequential case already gives. Fixed by catching P2002, same pattern as
   registerStudent.

   Caveat, checked rather than assumed: this test still PASSED even with the
   fix temporarily removed — same finding as the bag-race behavioral test
   earlier this session (tests/bag-race-behavioral.test.ts). The critical
   section here is very short (one findUnique, then the write), and this
   remote test DB's connection/latency characteristics don't reliably force
   two "concurrent" Promise.all calls to actually race inside a window that
   narrow. The fix is still correct and closes a real gap (an unhandled
   P2002 would otherwise surface as a raw 500 instead of a friendly error);
   this test documents the intended behavior rather than proving the old
   code was exploitable under the exact conditions tried here. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.91" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-update-phone-race.db");
const SCHEMA = "ff_update_phone_race";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let admin: typeof import("../lib/actions/admin");

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
  admin = await import("../lib/actions/admin");

  await db.college.create({ data: { id: "col1", name: "Phone Race College", features: {} } });
  const staff = await db.staff.create({ data: { phone: "9000000090", name: "Admin", role: 3, collegeId: "col1" } });
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
}, 300_000);

describe("updateStudentPhone survives a concurrent duplicate-number race", () => {
  it("two students both moving to the SAME new number: exactly one succeeds, the other gets a friendly error, not a crash", async () => {
    await db.student.create({ data: { id: "222201", phone: "9999902201", name: "A", collegeId: "col1", credits: 0 } });
    await db.student.create({ data: { id: "222202", phone: "9999902202", name: "B", collegeId: "col1", credits: 0 } });

    const [r1, r2] = await Promise.all([
      admin.updateStudentPhone("222201", "9999909999"),
      admin.updateStudentPhone("222202", "9999909999"),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok).length).toBe(1);
    const loser = results.find((r) => !r.ok);
    expect(loser).toBeDefined();
    if (loser && !loser.ok) expect(loser.error).toMatch(/already registered/);
  });
});
