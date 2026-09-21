/* Behavioral fuzz (real actions, real test DB) for the staff actions that take
   an amount typed by a person: submitExpense and createPayslip. Found in the
   Sep 21 testing pass: submitExpense accepted Infinity / absurdly large
   amounts and ANY `method` string, and createPayslip let NaN through because
   `NaN < 0` is false. A crafted or fat-fingered value must be refused cleanly
   (a friendly error, no row written) — not crash at the database or plant a
   nonsense figure in the reports. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.96" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_money_fuzz";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let admin: typeof import("../lib/actions/admin");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });
  db = (await import("../lib/db")).db;
  admin = await import("../lib/actions/admin");
  const authLib = await import("../lib/auth");
  await db.college.create({ data: { id: "col1", name: "Fuzz College", features: {} } });
  await db.staff.create({ data: { id: "adm1", phone: "9000000020", name: "Admin", role: 3, active: true, collegeId: "col1" } });
  await db.staff.create({ data: { id: "stf2", phone: "9000000021", name: "Worker", role: 1, active: true, collegeId: "col1" } });
  await authLib.createSession({ mode: "staff", staffId: "adm1", role: 3, epoch: 0 });
}, 300_000);

const expense = (over: Record<string, unknown> = {}) =>
  admin.submitExpense({ category: "Supplies", amount: 100, note: "n", method: "cash", ...over } as never);
const slip = (over: Record<string, unknown> = {}) =>
  admin.createPayslip({ staffId: "stf2", month: "2026-09", basic: 10000, allowances: 0, deductions: 0, postExpense: false, ...over } as never);

describe("submitExpense refuses bad input, writes nothing", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["NaN", { amount: NaN }], ["Infinity", { amount: Infinity }], ["-Infinity", { amount: -Infinity }],
    ["negative", { amount: -50 }], ["zero", { amount: 0 }], ["fraction below 1", { amount: 0.4 }],
    ["absurdly large", { amount: 1e15 }], ["a string that isn't a number", { amount: "abc" }],
    ["unknown method", { method: "refund" }], ["empty category", { category: "   " }],
    ["500-char category", { category: "x".repeat(500) }], ["missing note", { note: undefined }],
  ];
  for (const [label, over] of bad) {
    it(`rejects ${label}`, async () => {
      const before = await db.expense.count();
      const r = await expense(over); // must RETURN, not throw
      if (label === "missing note") return expect(r.ok).toBe(true); // an empty note is fine, just stored as null
      expect(r.ok, label).toBe(false);
      expect(await db.expense.count()).toBe(before);
    });
  }
  it("still accepts a normal expense (and a unicode note)", async () => {
    const r = await expense({ amount: 250.9, note: "चाय ☕ & साबुन" });
    expect(r.ok).toBe(true);
    const row = await db.expense.findFirstOrThrow({ orderBy: { at: "desc" } });
    expect(Number(row.amount)).toBe(250);
  });
});

describe("createPayslip refuses bad numbers, writes nothing", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["NaN basic", { basic: NaN }], ["Infinity basic", { basic: Infinity }],
    ["NaN deductions", { deductions: NaN }], ["negative basic", { basic: -1 }],
    ["negative allowances", { allowances: -500 }], ["negative deductions", { deductions: -500 }],
    ["absurdly large basic", { basic: 1e15 }], ["deductions exceeding pay", { deductions: 20000 }],
  ];
  for (const [label, over] of bad) {
    it(`rejects ${label}`, async () => {
      const before = await db.payslip.count();
      const r = await slip(over); // must RETURN an error, not throw (a throw is a 500)
      expect((r as { ok: boolean }).ok, label).toBe(false);
      expect(await db.payslip.count()).toBe(before);
    });
  }
  it("still issues a normal payslip", async () => {
    const r = await slip({ basic: 12000, allowances: 500, deductions: 200 });
    expect(r.ok).toBe(true);
  });
});
