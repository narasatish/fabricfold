/* Behavioral test (real function calls against a real, SCHEMA-ISOLATED test
   DB, not a source-regex check) for a bug found 2026-09-05: issueBag's
   "already has an active bag" guard locked the Bag row with a raw
   `SELECT ... FOR UPDATE` that was never schema-qualified via dbSchemaPrefix,
   unlike every other raw lock in this codebase (db.ts's own dbSchemaPrefix
   comment names this exact class of bug, previously found and fixed in
   flushSheetOutbox). An unqualified raw table reference hits the
   connection's default search_path, not necessarily the schema the rest of
   the query (built through Prisma's ORM) actually targets — under any
   DATABASE_URL with a `?schema=...` param (every isolated test schema in
   this suite, and any deployment that ever sets one), the lock was
   pointing at the wrong copy of the table, silently protecting nothing.

   Caveat, checked directly rather than assumed: reverting the fix and
   re-running this exact test still passed both times tried — the two
   concurrent issueBag calls happen to still serialize enough over this
   remote test DB's connection/latency characteristics that this specific
   test doesn't reliably force the corrupted-lock window open. The fix
   itself is correct and consistent with the rest of the codebase (and
   worth keeping regardless), but this test should be read as "the
   documented behavior holds," not as proof the old code was exploitable
   under the exact conditions exercised here. */
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
