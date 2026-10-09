/* One open draft per student (owner, Oct 2026: "bulk drafts... hectic") —
   placeOrder refuses a second draft while one is already open, and the
   student's own deleteDraft (never staff-only) clears the way for another. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.93" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_one_open_draft";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let orders: typeof import("../lib/actions/orders");

beforeAll(async () => {
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: BASE.split("?")[0] });
  await admin.connect();
  await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await admin.end();
  execSync("npx prisma db push", {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  orders = await import("../lib/actions/orders");

  await db.appConfig.create({
    data: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: { washIron: { label: "Wash & Iron", items: [["Garment", 15]] } },
      payment: { upiId: "ff@test", payeeName: "Test", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });
  await db.college.create({ data: { id: "col1", name: "Draft College", features: {} } });
}, 300_000);

describe("one open draft at a time", () => {
  const as = async (studentId: string) => {
    cookieJar.clear();
    await auth.createSession({ mode: "customer", studentId, epoch: 0 });
  };
  const place = () => orders.placeOrder({ service: "washIron", items: [{ label: "Garment", qty: 2 }], express: false });

  it("a second draft is refused while the first is still open", async () => {
    const s = await db.student.create({ data: { id: "222201", phone: "9999902201", name: "Dupe Drafter", collegeId: "col1", credits: 0 } });
    await as(s.id);
    const first = await place();
    expect(first.ok).toBe(true);
    const second = await place();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/pending order/i);
    expect(await db.order.count({ where: { studentId: s.id, status: "draft" } })).toBe(1);
  });

  it("deleting the draft clears the way for a new one", async () => {
    const s = await db.student.create({ data: { id: "222202", phone: "9999902202", name: "Clears Draft", collegeId: "col1", credits: 0 } });
    await as(s.id);
    const first = await place();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const del = await orders.deleteDraft(first.id);
    expect(del.ok).toBe(true);
    const second = await place();
    expect(second.ok).toBe(true);
  });

  it("a different student is never blocked by someone else's draft", async () => {
    const a = await db.student.create({ data: { id: "222203", phone: "9999902203", name: "Student A", collegeId: "col1", credits: 0 } });
    const b = await db.student.create({ data: { id: "222204", phone: "9999902204", name: "Student B", collegeId: "col1", credits: 0 } });
    await as(a.id);
    expect((await place()).ok).toBe(true);
    await as(b.id);
    expect((await place()).ok).toBe(true);
  });

  it("the new-order page sends a student with an open draft straight to it", () => {
    const fs = require("node:fs");
    const src = fs.readFileSync(path.resolve(__dirname, "..", "app/c/order/new/page.tsx"), "utf8");
    expect(src).toMatch(/status: "draft"/);
    expect(src).toMatch(/redirect\(`\/c\/orders\/\$\{openDraft\.id\}/);
  });
});
