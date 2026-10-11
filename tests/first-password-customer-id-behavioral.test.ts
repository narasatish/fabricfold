/* Behavioral test for createPasswordWithCustomerId (lib/actions/auth.ts,
   2026-10-11): a student with no password yet proves who they are with
   their customer ID instead of a WhatsApp OTP, which has been slow or not
   arriving on some phones. Proves: the happy path signs them in and sets
   a real password; a wrong ID is refused without revealing anything; the
   same account's wrong-try lockout from loginWithPasscode applies here
   too; an account that already has a password is refused; and a weak
   password is refused even with the right ID. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.97" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_first_pw_customer_id";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/actions/auth");
let admin: typeof import("../lib/actions/admin");
let authLib: typeof import("../lib/auth");

beforeAll(async () => {
  const { Client } = await import("pg");
  const pgAdmin = new Client({ connectionString: BASE.split("?")[0] });
  await pgAdmin.connect();
  await pgAdmin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await pgAdmin.end();
  execSync("npx prisma db push", {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
  db = (await import("../lib/db")).db;
  auth = await import("../lib/actions/auth");
  admin = await import("../lib/actions/admin");
  authLib = await import("../lib/auth");

  await db.college.create({ data: { id: "col1", name: "First Password College", features: {} } });
  await db.staff.create({ data: { id: "mgr1", phone: "9888800001", name: "Manager", role: 2, collegeId: "col1", active: true } });
}, 300_000);

let seq = 0;
const nextPhone = () => `98${String(7000000 + ++seq).padStart(8, "0")}`;

async function mkStudent(code: string, withPassword = false) {
  const phone = nextPhone();
  const stu = await db.student.create({ data: { id: `fp${seq}`, phone, name: `Student ${seq}`, collegeId: "col1", credits: 0 } });
  await db.bag.create({ data: { code, studentId: stu.id, status: "active", complimentary: true, issuedBy: "test" } });
  if (withPassword) {
    const { hashPasscode } = await import("../lib/password");
    const { hash, salt } = await hashPasscode("existingpw");
    await db.student.update({ where: { id: stu.id }, data: { passwordHash: hash, passwordSalt: salt } });
  }
  return { ...stu, phone };
}

describe("createPasswordWithCustomerId", () => {
  it("the right phone + customer ID sets a real password and signs in", async () => {
    cookieJar.clear();
    const stu = await mkStudent("S9001");
    const r = await auth.createPasswordWithCustomerId(stu.phone, "S9001", "mynewpass1");
    expect(r.ok).toBe(true);
    const fresh = await db.student.findUniqueOrThrow({ where: { id: stu.id } });
    expect(fresh.passwordHash).not.toBeNull();
    expect(fresh.passwordHash).not.toContain("mynewpass1"); // never the plaintext
    expect(cookieJar.size).toBeGreaterThan(0); // a session cookie was set
  });

  it("a lowercase or spaced customer ID still matches", async () => {
    cookieJar.clear();
    const stu = await mkStudent("S9002");
    const r = await auth.createPasswordWithCustomerId(stu.phone, " s9002 ", "mynewpass1");
    expect(r.ok).toBe(true);
  });

  it("the wrong customer ID is refused with a generic message", async () => {
    cookieJar.clear();
    const stu = await mkStudent("S9003");
    const r = await auth.createPasswordWithCustomerId(stu.phone, "S9999", "mynewpass1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/incorrect/i);
    const fresh = await db.student.findUniqueOrThrow({ where: { id: stu.id } });
    expect(fresh.passwordHash).toBeNull(); // nothing was set
  });

  it("an unknown phone number gets the same generic message (no account enumeration)", async () => {
    cookieJar.clear();
    const r = await auth.createPasswordWithCustomerId("9888000001", "S0001", "mynewpass1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/incorrect/i);
  });

  it("locks the account after enough wrong customer IDs, same as loginWithPasscode", async () => {
    cookieJar.clear();
    const stu = await mkStudent("S9004");
    let lastError = "";
    for (let i = 0; i < 5; i++) {
      const r = await auth.createPasswordWithCustomerId(stu.phone, "WRONGID", "mynewpass1");
      expect(r.ok).toBe(false);
      if (!r.ok) lastError = r.error;
    }
    expect(lastError).toMatch(/locked/i);
    // Even the RIGHT id is refused while locked.
    const r = await auth.createPasswordWithCustomerId(stu.phone, "S9004", "mynewpass1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/locked/i);
  });

  it("refuses an account that already has a password", async () => {
    cookieJar.clear();
    const stu = await mkStudent("S9005", true);
    const r = await auth.createPasswordWithCustomerId(stu.phone, "S9005", "mynewpass1");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already has a password/i);
  });

  it("refuses a weak password even with the right customer ID", async () => {
    cookieJar.clear();
    const stu = await mkStudent("S9006");
    const r = await auth.createPasswordWithCustomerId(stu.phone, "S9006", "abc");
    expect(r.ok).toBe(false);
    const fresh = await db.student.findUniqueOrThrow({ where: { id: stu.id } });
    expect(fresh.passwordHash).toBeNull();
  });
});

describe("resetStudentPassword (staff)", () => {
  it("clears the password and lockout, letting the student set a new one with their customer ID", async () => {
    cookieJar.clear();
    const stu = await mkStudent("S9007", true);
    // Lock the account first, to prove reset clears that too.
    for (let i = 0; i < 5; i++) await auth.createPasswordWithCustomerId(stu.phone, "WRONG", "x");

    await authLib.createSession({ mode: "staff", staffId: "mgr1", role: 2, epoch: 0 });
    const r = await admin.resetStudentPassword(stu.id);
    expect(r.ok).toBe(true);

    const fresh = await db.student.findUniqueOrThrow({ where: { id: stu.id } });
    expect(fresh.passwordHash).toBeNull();
    expect(fresh.pwLockedUntil).toBeNull();
    expect(fresh.pwFailedAttempts).toBe(0);

    cookieJar.clear();
    const setAgain = await auth.createPasswordWithCustomerId(stu.phone, "S9007", "brandnewpw1");
    expect(setAgain.ok).toBe(true);
  });
});
