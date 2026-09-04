/* OTP security tests.

   The critical property: a FIXED code (DEV_OTP) must never be mintable for an
   arbitrary phone number in production. Before this guard, DEV_OTP=123456 in
   prod meant 123456 logged you into ANY account â€” including the Owner.

   genCode is module-private, so we exercise it through requestOtp() and read
   back what actually got stored for that number. */
import "dotenv/config";
import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { ensureTestSchema } from "./_schema";
import path from "node:path";

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_URL = IS_PG ? BASE.split("?")[0] + "?schema=ff_test" : "file:" + path.resolve(__dirname, "../test.db");
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/actions/auth");

const setEnv = (k: string, v: string) => { (process.env as Record<string, string | undefined>)[k] = v; };

const OWNER = "8019121966";   // a real privileged account
const ATTACKER_TARGET = "9000000002"; // staff number an attacker might guess
const ALLOWED = "7799661888";

/** What code actually got stored for this phone? */
async function storedCode(phone: string) {
  const row = await db.otp.findFirst({ where: { phone, purpose: "login" }, orderBy: { expiresAt: "desc" } });
  return row?.code;
}

beforeAll(async () => {
  db = (await import("../lib/db")).db;
  await ensureTestSchema(TEST_URL, async () => {
    /* Probe the NEWEST schema addition, not an old table: a probe that checks
       something ancient reports "current" forever and lets every later column
       drift past it — exactly how Student.kind went missing here once. */
      try { await db.college.findFirst({ select: { rates: true } }); await db.waVerify.findFirst({ select: { collegeId: true } }); return true; } catch { return false; }
  });
  auth = await import("../lib/actions/auth");
  // requestOtp for a staff mode number requires the staff row to exist
  await db.staff.upsert({
    where: { phone: ATTACKER_TARGET }, update: {},
    create: { name: "Sec Test Admin", phone: ATTACKER_TARGET, role: 3 },
  });
  // `prisma db push` against a remote Postgres is the slow part, and it grows
  // with the schema â€” 120s was already marginal and broke once the Bag table
  // landed. Kept generous on purpose: this hook is setup, not a perf budget.
}, 300_000);

beforeEach(async () => {
  /* Reset the RATE LIMITER, not just the OTP rows.

     requestOtp allows five codes per number per hour, and that counter lives
     in the database. This file calls it repeatedly for the same three numbers,
     so the rows survived each run and accumulated across runs: the Owner
     number was found sitting at exactly 5. Past the cap requestOtp refuses,
     stores nothing, and the "no code stored" guard fires.

     Which made this file pass or fail depending on how many times it had run
     in the previous hour: green alone, red in a full suite, green again later.
     Clearing the counter makes every test start from the same place. */
  await db.rateLimit.deleteMany({ where: { key: { startsWith: "otp:" } } });

  /* requestOtp refuses a number it cannot text, so without this these tests
     would store no code at all â€” and assertions like `not.toBe("123456")`
     would pass against `undefined`, guarding nothing. Dry-run keeps delivery
     "possible" while sending nothing. */
  process.env.SMS_DRY_RUN = "1";
});

afterEach(async () => {
  await db.otp.deleteMany({ where: { purpose: "login" } });
  await db.rateLimit.deleteMany({ where: { key: { startsWith: "otp:" } } });
  delete process.env.TEST_PHONES;
  delete process.env.SMS_DRY_RUN;
});

describe("OTP: a fixed code must never be a master key in production", () => {
  it("PRODUCTION + DEV_OTP set + number NOT allowlisted -> random code, not the fixed one", async () => {
    setEnv("NODE_ENV", "production");
    process.env.DEV_OTP = "123456";
    process.env.TEST_PHONES = ALLOWED; // owner deliberately NOT listed

    await auth.requestOtp(OWNER, "customer");
    const code = await storedCode(OWNER);

    // THE regression guard: 123456 must not open the Owner account
    expect(code).not.toBe("123456");
    expect(code).toMatch(/^\d{6}$/);
  });

  it("PRODUCTION + DEV_OTP set + NO allowlist at all -> still random (fails closed)", async () => {
    setEnv("NODE_ENV", "production");
    process.env.DEV_OTP = "123456";
    delete process.env.TEST_PHONES;

    await auth.requestOtp(OWNER, "customer");
    expect(await storedCode(OWNER)).not.toBe("123456");
  });

  it("an attacker cannot get the fixed code for a staff number they guessed", async () => {
    setEnv("NODE_ENV", "production");
    process.env.DEV_OTP = "123456";
    process.env.TEST_PHONES = ALLOWED;

    await auth.requestOtp(ATTACKER_TARGET, "staff");
    expect(await storedCode(ATTACKER_TARGET)).not.toBe("123456");
  });

  it("an ALLOWLISTED test number still gets the fixed code, so testing keeps working", async () => {
    setEnv("NODE_ENV", "production");
    process.env.DEV_OTP = "123456";
    process.env.TEST_PHONES = `${ALLOWED},${OWNER}`;

    await auth.requestOtp(ALLOWED, "customer");
    expect(await storedCode(ALLOWED)).toBe("123456");
  });

  it("with DEV_OTP unset, codes are always random even in dev", async () => {
    setEnv("NODE_ENV", "development");
    delete process.env.DEV_OTP;

    await auth.requestOtp(OWNER, "customer");
    const code = await storedCode(OWNER);
    expect(code).toMatch(/^\d{6}$/);
    expect(code).not.toBe("123456");
  });

  it("generated codes are 6 digits and vary between requests", async () => {
    setEnv("NODE_ENV", "production");
    delete process.env.DEV_OTP;

    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const phone = `90000001${i}0`.slice(-10);
      await auth.requestOtp(phone, "customer");
      const c = await storedCode(phone);
      expect(c).toMatch(/^\d{6}$/);
      seen.add(c!);
    }
    // 5 crypto-random codes colliding would be ~1 in 10^24
    expect(seen.size).toBeGreaterThan(1);
  });

  it("a code is actually generated â€” so the guards above aren't passing on undefined", async () => {
    setEnv("NODE_ENV", "production");
    process.env.DEV_OTP = "123456";
    process.env.TEST_PHONES = ALLOWED;

    await auth.requestOtp(OWNER, "customer");
    const code = await storedCode(OWNER);
    expect(code, "no code stored â€” every `not.toBe` assertion here would pass vacuously").toBeDefined();
    expect(code).toMatch(/^\d{6}$/);
  });

  it("refuses outright when the code could never be delivered", async () => {
    // no provider, no dry-run, number not allowlisted: pretending to send left
    // students waiting for an SMS that was only ever a console.log
    setEnv("NODE_ENV", "production");
    delete process.env.SMS_DRY_RUN;
    process.env.DEV_OTP = "123456";
    process.env.TEST_PHONES = ALLOWED;

    const r = await auth.requestOtp(OWNER, "customer");
    expect(r.ok).toBe(false);
    expect(await storedCode(OWNER)).toBeUndefined();
  });
});
