/* Behavioral test (real function calls against a real test DB, not a
   source-regex check) for a bug found 2026-09-05: loginWithPasscode's
   failed-attempt counter is the ONLY brute-force defense on passcode
   sign-in — unlike requestOtp, there is no rateLimit() call anywhere on
   this path, and a passcode can be as short as 4 characters (MIN_PASSCODE),
   a 4-digit numeric PIN having only 10,000 combinations.

   The counter was read (via a plain findUnique before any lock) and written
   back with a plain update — a classic lost-update: N concurrent wrong
   guesses all read the SAME base pwFailedAttempts, all compute the SAME
   "attempts + 1", and all write that same value. Sent in parallel batches
   instead of one at a time, an attacker's guesses would never actually
   accumulate past a single increment, so the 5-attempt lockout could be
   bypassed entirely — turning a rate-limited PIN into an effectively
   unlimited-guess one. Fixed by locking the Student row and re-reading it
   fresh before computing the next attempt count, the same pattern used for
   every money-moving transaction in this codebase. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.93" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-passcode-race.db");
const SCHEMA = "ff_passcode_race";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let authActions: typeof import("../lib/actions/auth");
let password: typeof import("../lib/password");

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
  authActions = await import("../lib/actions/auth");
  password = await import("../lib/password");

  await db.college.create({ data: { id: "col1", name: "Passcode Race College", features: {} } });
}, 300_000);

async function mkStudentWithPasscode(id: string, phone: string, passcode: string) {
  const { hash, salt } = await password.hashPasscode(passcode);
  await db.student.create({
    data: { id, phone, name: "Racer " + id, collegeId: "col1", credits: 0, passwordHash: hash, passwordSalt: salt, passwordSetAt: new Date() },
  });
}

describe("loginWithPasscode's failed-attempt counter can't be evaded by concurrent guesses", () => {
  it("MAX_PW_ATTEMPTS concurrent wrong guesses lock the account, not fewer", async () => {
    await mkStudentWithPasscode("999901", "9999900901", "7391");

    // Fire exactly MAX_PW_ATTEMPTS wrong guesses AT ONCE. The bug this test
    // targets would have every one of them read the same starting count (0)
    // and write back 1 — leaving the account unlocked no matter how many
    // parallel wrong guesses land. Correct behavior: they serialize through
    // the row lock and the count actually reaches MAX_PW_ATTEMPTS, locking.
    const attempts = Array.from({ length: password.MAX_PW_ATTEMPTS }, () =>
      authActions.loginWithPasscode("9999900901", "0000"),
    );
    const results = await Promise.all(attempts);
    expect(results.every((r) => r.ok === false)).toBe(true);

    const stu = await db.student.findUniqueOrThrow({ where: { id: "999901" } });
    expect(stu.pwFailedAttempts).toBe(0); // reset to 0 the moment the lock engages
    expect(stu.pwLockedUntil).not.toBeNull();
    expect(stu.pwLockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Locked out now — even the CORRECT passcode must be refused.
    const whileLocked = await authActions.loginWithPasscode("9999900901", "7391");
    expect(whileLocked.ok).toBe(false);
    if (!whileLocked.ok) expect(whileLocked.error).toMatch(/locked/i);
  });

  it("fewer than MAX_PW_ATTEMPTS concurrent wrong guesses do NOT lock the account", async () => {
    await mkStudentWithPasscode("999902", "9999900902", "8462");

    const fewer = password.MAX_PW_ATTEMPTS - 1;
    const attempts = Array.from({ length: fewer }, () =>
      authActions.loginWithPasscode("9999900902", "0000"),
    );
    await Promise.all(attempts);

    const stu = await db.student.findUniqueOrThrow({ where: { id: "999902" } });
    // The bug this test targets in reverse: without the lock, this count
    // could also be WRONG in the other direction if the fix over-corrected
    // (e.g. double-counting each request). It must land exactly on fewer,
    // not more and not fewer.
    expect(stu.pwFailedAttempts).toBe(fewer);
    expect(stu.pwLockedUntil).toBeNull();

    // Still not locked — the correct passcode works.
    const correct = await authActions.loginWithPasscode("9999900902", "8462");
    expect(correct.ok).toBe(true);
  });
});
