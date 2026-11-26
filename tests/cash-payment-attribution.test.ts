/* Behavioral test for the 2026-11 cash fraud-tightening pass: recordPay
   (lib/actions/orders.ts) now stamps Payment.recordedBy with the acting
   staff member's id, and writes an AuditLog entry for EVERY cash payment,
   not only the pre-existing "GST bill for cash" override case. Before this,
   a plain cash payment left no trace of which staff member took it beyond
   the general request log. */
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
const SCHEMA = "ff_cash_attribution";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let orders: typeof import("../lib/actions/orders");

beforeAll(async () => {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: BASE.split("?")[0] });
  await c.connect();
  await c.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await c.end();
  execSync("npx prisma db push", { cwd: path.resolve(__dirname, ".."), stdio: "ignore", env: { ...process.env, DATABASE_URL: TEST_URL } });

  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  orders = await import("../lib/actions/orders");

  await db.college.create({ data: { id: "col1", name: "Cash Attribution College", features: {} } });
  await db.student.create({ data: { id: "cstu1", phone: "9000000051", name: "Cash Payer", collegeId: "col1" } });
}, 300_000);

const asStaff = async (staffPhone: string) => {
  cookieJar.clear();
  const staff = await db.staff.create({ data: { phone: staffPhone, name: "Counter Staff", role: 1, collegeId: "col1" } });
  await auth.createSession({ mode: "staff", staffId: staff.id, role: 1, epoch: staff.sessionEpoch });
  return staff;
};

const mkOrder = (id: string) =>
  db.order.create({
    data: {
      id, studentId: "cstu1", collegeId: "col1", service: "washFold", items: [{ label: "Regular garment", rate: 15, qty: 2 }],
      declaredPieces: 2, status: "received", subtotal: 100, gst: 0, gstPctSnapshot: 0, total: 100, receivedAt: new Date(),
    },
  });

describe("recordPay attributes a cash payment to the staff member who took it", () => {
  it("stamps Payment.recordedBy and writes an AuditLog entry, for a plain cash payment (no GST override)", async () => {
    const staff = await asStaff("9000000061");
    await mkOrder("CASH01");

    const r = await orders.recordPay("CASH01", "cash", false, false);
    expect(r.ok).toBe(true);

    const payment = await db.payment.findFirstOrThrow({ where: { orderId: "CASH01", method: "cash" } });
    expect(payment.recordedBy).toBe(staff.id);

    const logs = await db.auditLog.findMany({ where: { by: staff.id, action: "Cash payment recorded" } });
    expect(logs.length).toBe(1);
    expect(logs[0].detail).toContain("CASH01".slice(-4));
  });

  it("does not attribute a student's own UPI self-payment to any staff member", async () => {
    const stu = await db.student.findUniqueOrThrow({ where: { id: "cstu1" } });
    cookieJar.clear();
    await auth.createSession({ mode: "customer", studentId: stu.id, epoch: stu.sessionEpoch });
    await mkOrder("UPI01");

    const r = await orders.payOrder("UPI01", "upi", false);
    expect(r.ok).toBe(true);

    const payment = await db.payment.findFirstOrThrow({ where: { orderId: "UPI01", method: "upi" } });
    expect(payment.recordedBy).toBeNull();
  });
});
