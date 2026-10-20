/* eraseMyData/eraseStudentData's preconditions, exercised for REAL — not by
   reading source text. Found 2026-10-20 in a deep audit: both functions
   checked `anonymisedAt` and "any active order" OUTSIDE the transaction,
   with no lock and no re-check inside it. Two concurrent erasure calls for
   the same student (a double-tap, or a student and a staff member both
   acting on the same account near-simultaneously) could both pass the
   stale check and both proceed to write — harmless for the anonymised
   fields themselves (both converge on "Deleted student"), but
   `sessionEpoch: { increment: 1 }` would double-increment, and more
   importantly nothing actually re-verified the precondition was still true
   at write time. Fixed with the same lock-then-fresh-recheck pattern used
   everywhere else in this codebase. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.91" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_erasure_race";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let privacy: typeof import("../lib/actions/privacy");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });

  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  privacy = await import("../lib/actions/privacy");

  await db.college.create({ data: { id: "col1", name: "Erasure Race College", features: {} } });
  const staff = await db.staff.create({ data: { phone: "9000000099", name: "Admin", role: 3, collegeId: "col1" } });
  await db.staff.update({ where: { id: staff.id }, data: {} });
  (globalThis as unknown as { __adminId: string }).__adminId = staff.id;
}, 300_000);

describe("eraseStudentData can't be double-run on the same student under concurrency", () => {
  it("two concurrent erasures of the same student: exactly one succeeds, sessionEpoch increments once, not twice", async () => {
    const stu = await db.student.create({ data: { id: "995501", phone: "9995500001", name: "Erase Racer", collegeId: "col1" } });
    const adminId = (globalThis as unknown as { __adminId: string }).__adminId;
    await auth.createSession({ mode: "staff", staffId: adminId, role: 3, epoch: 0 });

    const startEpoch = (await db.student.findUniqueOrThrow({ where: { id: stu.id } })).sessionEpoch;

    const [r1, r2] = await Promise.all([
      privacy.eraseStudentData(stu.id, "duplicate test call A"),
      privacy.eraseStudentData(stu.id, "duplicate test call B"),
    ]);
    const results = [r1, r2];
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).length).toBe(1);
    expect(results.find((r) => !r.ok)!.error).toMatch(/already been erased/);

    const after = await db.student.findUniqueOrThrow({ where: { id: stu.id } });
    expect(after.name).toBe("Deleted student");
    // The bug this test targets would let BOTH calls' anonymisedFields()
    // apply, double-incrementing sessionEpoch (startEpoch+2) instead of once.
    expect(after.sessionEpoch).toBe(startEpoch + 1);
  });
});
