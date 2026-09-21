/* Behavioral test (real actions, real DB): the piece count typed when marking an
   order ready. Found in the Sep 21 QA pass driving the real UI: entering -2 was
   silently clamped to 0, so the app stored actualPieces = 0 and logged a false
   "Piece shortfall at ready: intake 3 -> counted 0" alert - a phantom loss from a
   typo. Invalid counts must be refused, leaving the order where it was; valid
   counts (including a genuine shortfall) still work. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.101" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-ready-count-guard.db");
const SCHEMA = "ff_ready_count_guard";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let orders: typeof import("../lib/actions/orders");

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
  orders = await import("../lib/actions/orders");

  await db.appConfig.create({
    data: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: { ironOnly: { label: "Iron Only", items: [["Garment", 15]] } },
      payment: { upiId: "ff@test", payeeName: "Test", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });
  await db.college.create({ data: { id: "col1", name: "Advance Race College", features: {} } });
  const staff = await db.staff.create({ data: { phone: "9000000083", name: "Counter", role: 1, collegeId: "col1" } });
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
  await db.student.create({ data: { id: "444402", phone: "9999904402", name: "Race Student", collegeId: "col1", credits: 0 } });
}, 300_000);


const toProcessing = async () => {
  const placed = await orders.walkInOrder("444402", { service: "ironOnly", items: [{ label: "Garment", qty: 3 }], weightKg: null, useCycle: false });
  expect(placed.ok).toBe(true);
  if (!placed.ok) throw new Error("setup failed");
  expect((await orders.advanceStatus(placed.id)).ok).toBe(true); // received -> processing
  return placed.id;
};

describe("marking ready with a typed piece count", () => {
  const bad: [string, number][] = [["negative", -2], ["NaN", NaN], ["Infinity", Infinity], ["a fraction", 2.5], ["absurdly large", 100000]];
  for (const [label, n] of bad) {
    it(`refuses ${label} and leaves the order in processing, untouched`, async () => {
      const id = await toProcessing();
      const r = await orders.advanceStatus(id, { countedPieces: n });
      expect(r.ok, label).toBe(false);
      const o = await db.order.findUniqueOrThrow({ where: { id } });
      expect(o.status).toBe("processing");
      expect(o.actualPieces).toBe(3); // still the drop-off count
      expect(await db.auditLog.count({ where: { action: "Piece shortfall at ready", detail: { contains: "#" + id.slice(-4) } } })).toBe(0);
    });
  }
  it("a matching count marks it ready with no shortfall alert", async () => {
    const id = await toProcessing();
    expect((await orders.advanceStatus(id, { countedPieces: 3 })).ok).toBe(true);
    expect((await db.order.findUniqueOrThrow({ where: { id } })).status).toBe("ready");
  });
  it("a GENUINE shortfall (counted 2 of 3) is still recorded, as before", async () => {
    const id = await toProcessing();
    expect((await orders.advanceStatus(id, { countedPieces: 2 })).ok).toBe(true);
    const o = await db.order.findUniqueOrThrow({ where: { id } });
    expect([o.status, o.actualPieces]).toEqual(["ready", 2]);
    expect(await db.auditLog.count({ where: { action: "Piece shortfall at ready", detail: { contains: "#" + id.slice(-4) } } })).toBe(1);
  });
  it("no count typed (null) still works", async () => {
    const id = await toProcessing();
    expect((await orders.advanceStatus(id)).ok).toBe(true);
  });
});
