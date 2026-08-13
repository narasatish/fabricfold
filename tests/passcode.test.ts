/* Passcode hashing and policy.

   The pure crypto is tested for real here; the DB-backed sign-in flow is
   asserted at source level below, since it needs a session. */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  hashPasscode, verifyPasscode, passcodeProblem,
  lockoutMinutesLeft, MIN_PASSCODE, MAX_PW_ATTEMPTS,
} from "../lib/password";

describe("passcode hashing", () => {
  it("never stores the passcode itself", async () => {
    const { hash, salt } = await hashPasscode("7391");
    expect(hash).not.toContain("7391");
    expect(salt).not.toContain("7391");
    expect(hash.length).toBeGreaterThan(60); // 64-byte key, hex encoded
  });

  it("salts, so identical passcodes hash differently", async () => {
    const a = await hashPasscode("7391");
    const b = await hashPasscode("7391");
    expect(a.hash).not.toBe(b.hash);
    expect(a.salt).not.toBe(b.salt);
  });

  it("verifies the right passcode and rejects the wrong one", async () => {
    const { hash, salt } = await hashPasscode("7391");
    expect(await verifyPasscode("7391", hash, salt)).toBe(true);
    expect(await verifyPasscode("7392", hash, salt)).toBe(false);
    expect(await verifyPasscode("", hash, salt)).toBe(false);
  });

  it("fails closed when there is no stored hash", async () => {
    // a student who never set one must not be loggable-in with anything
    expect(await verifyPasscode("anything", null, null)).toBe(false);
    expect(await verifyPasscode("anything", "deadbeef", null)).toBe(false);
  });

  it("survives a mismatched hash length without throwing", async () => {
    // timingSafeEqual throws on unequal lengths; that must be handled, not crash
    expect(await verifyPasscode("7391", "ab", "cd")).toBe(false);
  });
});

describe("passcode policy", () => {
  it("enforces a minimum length", () => {
    expect(passcodeProblem("1")).toMatch(/at least/);
    expect(passcodeProblem("a".repeat(MIN_PASSCODE))).toBeNull();
  });

  it("rejects the passcodes everyone guesses first", () => {
    for (const bad of ["1234", "123456", "0000", "1111", "9999"]) {
      expect(passcodeProblem(bad), bad).not.toBeNull();
    }
  });

  it("accepts a reasonable one", () => {
    expect(passcodeProblem("7391")).toBeNull();
    expect(passcodeProblem("wash-day-42")).toBeNull();
  });
});

describe("lockout", () => {
  it("reports zero when not locked", () => {
    expect(lockoutMinutesLeft(null)).toBe(0);
    expect(lockoutMinutesLeft(new Date(Date.now() - 1000))).toBe(0);
  });
  it("counts minutes remaining while locked", () => {
    expect(lockoutMinutesLeft(new Date(Date.now() + 5 * 60_000))).toBe(5);
  });
});

describe("sign-in rules", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../lib/actions/auth.ts"), "utf8");
  const fn = (n: string) => {
    const i = src.indexOf(`export async function ${n}`);
    expect(i, `${n} not found`).toBeGreaterThan(-1);
    const j = src.indexOf("\nexport async function", i + 1);
    return src.slice(i, j === -1 ? undefined : j);
  };

  it("passcode sign-in is students only — staff stay OTP-only", () => {
    // a staff account takes payments; a guessable passcode should not reach it
    expect(fn("loginWithPasscode")).not.toMatch(/db\.staff/);
  });

  it("gives the same error whether the number is unknown or the passcode wrong", () => {
    // distinct messages would make this a directory of who is registered
    const f = fn("loginWithPasscode");
    expect(f).toMatch(/const generic = /);
    // same message for "no such number" and "wrong passcode"
    expect(f).toMatch(/!stu \|\| !stu\.passwordHash[\s\S]*generic/);
  });

  it("locks after repeated wrong tries", () => {
    expect(fn("loginWithPasscode")).toMatch(/MAX_PW_ATTEMPTS/);
    expect(MAX_PW_ATTEMPTS).toBeLessThanOrEqual(5);
  });

  it("points a locked-out student at OTP rather than stranding them", () => {
    expect(fn("loginWithPasscode")).toMatch(/Sign in with OTP/);
  });

  it("changing a passcode requires the current one", () => {
    // otherwise an unattended unlocked phone is a permanent takeover
    expect(fn("changePasscode")).toMatch(/verifyPasscode\(/);
    expect(fn("changePasscode")).toMatch(/Current passcode is wrong/);
  });

  it("setting a passcode requires an existing session", () => {
    // a passcode must never be settable from a phone number alone
    expect(fn("setPasscode")).toMatch(/requireStudent\(\)/);
  });

  it("hasPasscode doesn't reveal whether a number is registered", () => {
    const f = fn("hasPasscode");
    expect(f).toMatch(/hasPasscode: !!stu\?\.passwordHash/);
    expect(f).not.toMatch(/not registered/i);
  });
});
