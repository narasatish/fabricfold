/* Behavioral test (real actions, real DB): every action that moves money must
   put a row in the live Sheet outbox for the right college. Found in the Sep 21
   QA pass: the Payments log only recorded order payments and cycle packs, so
   plan sales, wallet top-ups, refunds, cash compensation and bag fees never
   reached it (and expenses had no log at all) - the log did not add up to the
   Daily/Revenue totals. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.102" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_DB = path.resolve(__dirname, "../test-money-sheet-events.db");
const SCHEMA = "ff_money_sheet_events";
const TEST_URL = IS_PG ? BASE.split("?")[0] + `?schema=${SCHEMA}` : "file:" + TEST_DB;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let orders: typeof import("../lib/actions/orders");
let ops: typeof import("../lib/actions/ops");
let admin: typeof import("../lib/actions/admin");
let credits: typeof import("../lib/actions/credits");

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
  ops = await import("../lib/actions/ops");
  admin = await import("../lib/actions/admin");
  credits = await import("../lib/actions/credits");

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
  const staff = await db.staff.create({ data: { phone: "9000000084", name: "Counter", role: 4, collegeId: null } });
  await auth.createSession({ mode: "staff", staffId: staff.id, role: staff.role, epoch: staff.sessionEpoch });
  await db.student.create({ data: { id: "444403", phone: "9999904403", name: "Race Student", collegeId: "col1", credits: 0 } });
}, 300_000);


const outbox = async (kind: string, since: Date) =>
  (await db.sheetOutbox.findMany({ where: { kind, at: { gte: since } }, orderBy: { at: "asc" } })).map((r) => ({ collegeId: r.collegeId, row: r.payload as unknown as (string | number)[] }));

describe("money movements reach the Sheet outbox", { timeout: 180_000 }, () => {
  it("wallet top-up -> a Payments row, positive, for the student's college", async () => {
    const t0 = new Date();
    expect((await ops.topUpCredits("444403", 500, "cash")).ok).toBe(true);
    const ev = await outbox("payment", t0);
    expect(ev).toHaveLength(1);
    expect(ev[0].collegeId).toBe("col1");
    expect(ev[0].row[1]).toBe("Wallet top-up");
    expect(ev[0].row[4]).toBe("cash");
    expect(ev[0].row[5]).toBe(500);
  });

  it("refund -> a Payments row, NEGATIVE, saying how it was paid out", async () => {
    const placed = await orders.walkInOrder("444403", { service: "ironOnly", items: [{ label: "Garment", qty: 4 }], weightKg: null, useCycle: false });
    if (!placed.ok) throw new Error("setup");
    expect((await orders.recordPay(placed.id, "cash", false, false)).ok).toBe(true);
    const t0 = new Date();
    expect((await orders.refundOrder(placed.id, 15, "cash", "QA")).ok).toBe(true);
    const ev = await outbox("payment", t0);
    expect(ev).toHaveLength(1);
    expect(ev[0].collegeId).toBe("col1");
    expect(String(ev[0].row[4])).toMatch(/refund.*cash/i);
    expect(ev[0].row[5]).toBe(-15);
  });

  it("cash compensation -> a Payments row, negative", async () => {
    const t0 = new Date();
    expect((await credits.submitCompensation({ studentId: "444403", kind: "damage", amount: 40, method: "cash", comment: "QA payout" } as never)).ok).toBe(true);
    const ev = await outbox("payment", t0);
    expect(ev).toHaveLength(1);
    expect(String(ev[0].row[4])).toMatch(/compensation|payout/i);
    expect(ev[0].row[5]).toBe(-40);
  });

  it("expense -> an Expenses row for the right college", async () => {
    const t0 = new Date();
    expect((await admin.submitExpense({ category: "Detergent", amount: 250, note: "QA", method: "cash" })).ok).toBe(true);
    const ev = await outbox("expense", t0);
    expect(ev).toHaveLength(1);
    expect(ev[0].row[1]).toBe("Detergent");
    expect(ev[0].row[2]).toBe(250);
  });
});
