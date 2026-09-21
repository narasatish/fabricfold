/* Behavioral fuzz (real actions, real test DB) for savePlan and saveSlotWindow.
   Found in the Sep 21 testing pass: NaN passes `x < 0 || x > 6`-style range
   checks, and fractions / Infinity / huge values reached Int and Decimal
   columns (a crash, or a nonsense plan). Each must be refused with a friendly
   error and write nothing; normal input must still save. */
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
const SCHEMA = "ff_admin_fuzz";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let admin: typeof import("../lib/actions/admin");
let slots: typeof import("../lib/actions/slots");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });
  db = (await import("../lib/db")).db;
  admin = await import("../lib/actions/admin");
  slots = await import("../lib/actions/slots");
  const authLib = await import("../lib/auth");
  await db.college.create({ data: { id: "col1", name: "Fuzz College", features: {} } });
  await db.staff.create({ data: { id: "adm1", phone: "9000000020", name: "Admin", role: 3, active: true, collegeId: "col1" } });
  await db.staff.create({ data: { id: "stf2", phone: "9000000021", name: "Worker", role: 1, active: true, collegeId: "col1" } });
  await authLib.createSession({ mode: "staff", staffId: "adm1", role: 3, epoch: 0 });
}, 300_000);

const plan = (over: Record<string, unknown> = {}) =>
  admin.savePlan({ collegeId: "col1", name: "Silver", price: 5000, gstFree: false, tier: "silver", buckets: [{ service: "washFold", cycles: 20, kgPerCycle: 7 }], ...over } as never);
const slot = (over: Record<string, unknown> = {}) =>
  slots.saveSlotWindow({ collegeId: "col1", weekday: 1, startMin: 540, endMin: 660, capacity: 15, ...over } as never);

describe("savePlan refuses bad input, writes nothing", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["Infinity price", { price: Infinity }], ["NaN price", { price: NaN }], ["negative price", { price: -1 }],
    ["absurd price", { price: 1e15 }], ["1-char name", { name: "A" }], ["500-char name", { name: "x".repeat(500) }],
    ["Infinity cycles", { buckets: [{ service: "washFold", cycles: Infinity, kgPerCycle: 7 }] }],
    ["fractional cycles", { buckets: [{ service: "washFold", cycles: 2.5, kgPerCycle: 7 }] }],
    ["huge cycles", { buckets: [{ service: "washFold", cycles: 1e9, kgPerCycle: 7 }] }],
    ["NaN kg", { buckets: [{ service: "washFold", cycles: 5, kgPerCycle: NaN }] }],
    ["negative kg", { buckets: [{ service: "washFold", cycles: 5, kgPerCycle: -3 }] }],
  ];
  for (const [label, over] of bad) {
    it(`rejects ${label}`, async () => {
      const before = await db.plan.count();
      const r = await plan(over);
      expect(r.ok, label).toBe(false);
      expect(await db.plan.count()).toBe(before);
    });
  }
  it("still saves a normal plan", async () => { expect((await plan()).ok).toBe(true); });
});

describe("saveSlotWindow refuses bad input, writes nothing", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["NaN weekday", { weekday: NaN }], ["fractional weekday", { weekday: 1.5 }], ["NaN capacity", { capacity: NaN }],
    ["fractional capacity", { capacity: 2.5 }], ["NaN start", { startMin: NaN }], ["fractional start", { startMin: 10.5 }],
    ["NaN end", { endMin: NaN }], ["Infinity end", { endMin: Infinity }], ["negative start", { startMin: -5 }],
  ];
  for (const [label, over] of bad) {
    it(`rejects ${label}`, async () => {
      const before = await db.slotWindow.count();
      const r = await slot(over);
      expect(r.ok, label).toBe(false);
      expect(await db.slotWindow.count()).toBe(before);
    });
  }
  it("still saves a normal window", async () => { expect((await slot()).ok).toBe(true); });
});
