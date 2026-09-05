/* Behavioral test (real function calls against a real test DB) for a gap
   found 2026-09-05: loginWithPasscode's per-account pwFailedAttempts
   lockout (fixed earlier the same day) only caps guesses against ONE phone
   number. Nothing stopped an attacker from spreading guesses across MANY
   different numbers — a few tries per account, never enough to trip any
   single account's 5-attempt lock, but still a live brute-force path
   against a passcode as short as 4 characters. Fixed with the same
   per-IP rateLimit() cap requestOtp already has, applied to the whole
   endpoint regardless of which phone number is being tried. */
import "dotenv/config";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const cookieJar = new Map<string, string>();
const FIXED_IP = "203.0.113.88";
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
    set: (name: string, value: string) => { cookieJar.set(name, value); },
    delete: (name: string) => { cookieJar.delete(name); },
  }),
  headers: async () => new Headers({ "x-forwarded-for": FIXED_IP }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-passcode-ip-ratelimit.db");
const SCHEMA = "ff_passcode_ip_ratelimit";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let authActions: typeof import("../lib/actions/auth");
let password: typeof import("../lib/password");

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
  authActions = await import("../lib/actions/auth");
  password = await import("../lib/password");

  await db.college.create({ data: { id: "col1", name: "IP Rate Limit College", features: {} } });
  // 25 different students, each with their own passcode — models an
  // attacker spreading guesses thin across many accounts instead of
  // hammering one, specifically to dodge the per-account lockout.
  for (let i = 0; i < 25; i++) {
    const { hash, salt } = await password.hashPasscode(`pass${i}`);
    await db.student.create({
      data: { id: `88880${i}`, phone: `988800${String(i).padStart(4, "0")}`, name: "Spread " + i, collegeId: "col1", credits: 0, passwordHash: hash, passwordSalt: salt, passwordSetAt: new Date() },
    });
  }
}, 300_000);

describe("loginWithPasscode is rate-limited per IP across different phone numbers", () => {
  it("spreading wrong guesses across many accounts from one IP still gets capped", async () => {
    // 25 sequential real network round trips against a remote test DB —
    // well past vitest's default 30s.
    const results: { ok: boolean; error?: string }[] = [];
    for (let i = 0; i < 25; i++) {
      const phone = `988800${String(i).padStart(4, "0")}`;
      results.push(await authActions.loginWithPasscode(phone, "wrong-guess"));
    }

    // No single account ever got close to its own 5-attempt lock (one wrong
    // guess each) — but the per-IP cap (20/hour) must kick in well before
    // the 25th distinct account is tried: exactly the last 5 of 25 calls
    // should be refused by the IP cap, not by any per-account lock.
    const capped = results.filter((r) => !r.ok && (r.error || "").includes("Too many attempts from this device"));
    expect(capped.length).toBe(5);
    // The first 20 calls should have gone through to the real passcode
    // check (and failed on a wrong guess, not on the IP cap).
    const wrongGuess = results.filter((r) => !r.ok && (r.error || "").includes("incorrect"));
    expect(wrongGuess.length).toBe(20);
  }, 120_000);
});
