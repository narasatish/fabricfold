/* `redoOrder` (lib/actions/orders.ts) and `grantFreeReservice`
   (lib/actions/complaints.ts) both give away a free wash — real staff time
   and consumables, the exact "money out the door" category the owner asked
   to gate behind the "refunds" tool ("we can't provide sensitive data or
   anything related to accounting to staff" — lib/perms.ts header comment).

   Every sibling money-giveaway action (refundOrder in orders.ts,
   submitCompensation in credits.ts) correctly calls
   `requireStaffPerm("refunds")`, so a Counter member gets refused by
   default and a Manager whose "refunds" tool the owner explicitly revoked
   also gets refused, regardless of their role.

   `redoOrder` instead called bare `requireStaff(1)` — the lowest role,
   with NO perm check at all, so literally any signed-in staff member
   (including a freshly-added Counter account with zero money tools) could
   call it directly and mint a free order. `grantFreeReservice` called
   `requireStaff(2)` — closer, but still a hardcoded role floor that
   ignores the owner's per-person "refunds" override entirely, so a Manager
   who had "refunds" explicitly revoked could still give away free
   re-services through the complaints flow.

   This test proves both server actions are reachable by a Counter staff
   member (no tool at all) and refused there, and that a Manager with the
   "refunds" tool explicitly revoked is also refused — the override must
   win, not just the role floor. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.92" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const SCHEMA = "ff_free_redo_perm";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let orders: typeof import("../lib/actions/orders");
let complaints: typeof import("../lib/actions/complaints");

async function makeOrder(id: string, studentId: string, collegeId: string) {
  return db.order.create({
    data: {
      id, studentId, collegeId, service: "wash",
      items: [{ label: "Shirt", rate: 20, qty: 5 }], declaredPieces: 5, actualPieces: 5,
      status: "processing", subtotal: 100, gst: 0, gstPctSnapshot: 0, total: 100,
      paid: true, paymentMethod: "upi",
    },
  });
}

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
  complaints = await import("../lib/actions/complaints");

  await db.appConfig.create({
    data: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: {
        wash: { label: "Wash & Fold", items: [["Shirt", 20]] },
      },
      payment: { upiId: "ff@test", payeeName: "Test", bankName: "", accountName: "", accountNo: "", ifsc: "", gatewayKey: "" },
      settings: { reportEmail: "", dailyEmail: false, sendHour: 21, lastSent: null, openingFloat: 0 },
    },
  });
  await db.college.create({ data: { id: "col1", name: "Free Redo Perm College", features: {} } });
}, 300_000);

describe("redoOrder requires the refunds tool, not just a bare role floor", () => {
  it("a Counter member (role 1, no tools granted) is refused", async () => {
    const counter = await db.staff.create({ data: { phone: "9000000101", name: "Counter", role: 1, collegeId: "col1" } });
    const stu = await db.student.create({ data: { id: "995601", phone: "9995600001", name: "Redo Target", collegeId: "col1" } });
    const o = await makeOrder("995601-ORD1", stu.id, "col1");

    await auth.createSession({ mode: "staff", staffId: counter.id, role: 1, epoch: 0 });
    await expect(orders.redoOrder(o.id)).rejects.toThrow(/refunds/i);

    // No order was actually created for free.
    const siblingOrders = await db.order.count({ where: { redoOfId: o.id } });
    expect(siblingOrders).toBe(0);
  });

  it("a Manager (role 2) with 'refunds' explicitly revoked is refused", async () => {
    const mgr = await db.staff.create({ data: { phone: "9000000102", name: "Revoked Manager", role: 2, collegeId: "col1", perms: { refunds: false } } });
    const stu = await db.student.create({ data: { id: "995602", phone: "9995600002", name: "Redo Target 2", collegeId: "col1" } });
    const o = await makeOrder("995602-ORD1", stu.id, "col1");

    await auth.createSession({ mode: "staff", staffId: mgr.id, role: 2, epoch: 0 });
    await expect(orders.redoOrder(o.id)).rejects.toThrow(/refunds/i);

    const siblingOrders = await db.order.count({ where: { redoOfId: o.id } });
    expect(siblingOrders).toBe(0);
  });

  it("a Counter member explicitly GRANTED 'refunds' can still redo (override wins both ways)", async () => {
    const counter = await db.staff.create({ data: { phone: "9000000103", name: "Trusted Counter", role: 1, collegeId: "col1", perms: { refunds: true } } });
    const stu = await db.student.create({ data: { id: "995603", phone: "9995600003", name: "Redo Target 3", collegeId: "col1" } });
    const o = await makeOrder("995603-ORD1", stu.id, "col1");

    await auth.createSession({ mode: "staff", staffId: counter.id, role: 1, epoch: 0 });
    const r = await orders.redoOrder(o.id);
    expect(r.ok).toBe(true);
  });
});

describe("grantFreeReservice requires the refunds tool, not just role >= 2", () => {
  it("a Manager with 'refunds' explicitly revoked is refused", async () => {
    const mgr = await db.staff.create({ data: { phone: "9000000104", name: "Revoked Manager 2", role: 2, collegeId: "col1", perms: { refunds: false } } });
    const stu = await db.student.create({ data: { id: "995604", phone: "9995600004", name: "Complainer", collegeId: "col1" } });
    const o = await makeOrder("995604-ORD1", stu.id, "col1");
    const complaint = await db.complaint.create({ data: { studentId: stu.id, orderId: o.id, collegeId: "col1", text: "Shirt stained" } });

    await auth.createSession({ mode: "staff", staffId: mgr.id, role: 2, epoch: 0 });
    await expect(complaints.grantFreeReservice(complaint.id)).rejects.toThrow(/refunds/i);

    const after = await db.complaint.findUniqueOrThrow({ where: { id: complaint.id } });
    expect(after.redoOrderId).toBeNull();
  });
});

/* `refundOrder` itself — much more serious, found while mutation-testing the
   fixes above. Its own comment (lib/actions/orders.ts, directly above the
   `requireStaff` call) and cancelOrder's comment a few hundred lines later
   both assert "Refunds are now a named tool: Manager+ by default" — and
   staff-perms.test.ts's "refunds: was requireStaff(1)" check asserts the
   same thing by grepping the file for `requireStaffPerm("refunds")`. But
   that string, before this fix, appeared NOWHERE in orders.ts — refundOrder
   itself still called bare `requireStaff(1)`, the exact "ANY staff could
   give money back" hole its own comment claims was closed. The file-grep
   test only passed by accident, because `redoOrder`'s unrelated fix above
   happened to introduce the one occurrence of that string the grep was
   looking for — it was never actually checking refundOrder. */
describe("refundOrder requires the refunds tool — the function the whole perms system exists for", () => {
  it("a Counter member (role 1, no tools granted) cannot give a refund", async () => {
    const counter = await db.staff.create({ data: { phone: "9000000105", name: "Counter Refunder", role: 1, collegeId: "col1" } });
    const stu = await db.student.create({ data: { id: "995605", phone: "9995600005", name: "Refund Target", collegeId: "col1" } });
    const o = await makeOrder("995605-ORD1", stu.id, "col1");

    await auth.createSession({ mode: "staff", staffId: counter.id, role: 1, epoch: 0 });
    await expect(orders.refundOrder(o.id, 50, "cash", "test")).rejects.toThrow(/refunds/i);

    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.refunded).toBe(false);
    const refundPayments = await db.payment.count({ where: { orderId: o.id, method: "refund" } });
    expect(refundPayments).toBe(0);
  });

  it("a Manager with 'refunds' explicitly revoked cannot give a refund", async () => {
    const mgr = await db.staff.create({ data: { phone: "9000000106", name: "Revoked Refunder", role: 2, collegeId: "col1", perms: { refunds: false } } });
    const stu = await db.student.create({ data: { id: "995606", phone: "9995600006", name: "Refund Target 2", collegeId: "col1" } });
    const o = await makeOrder("995606-ORD1", stu.id, "col1");

    await auth.createSession({ mode: "staff", staffId: mgr.id, role: 2, epoch: 0 });
    await expect(orders.refundOrder(o.id, 50, "cash", "test")).rejects.toThrow(/refunds/i);

    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.refunded).toBe(false);
  });

  it("a Manager (role >= 2, 'refunds' granted by default) CAN still refund", async () => {
    const mgr = await db.staff.create({ data: { phone: "9000000107", name: "Normal Manager", role: 2, collegeId: "col1" } });
    const stu = await db.student.create({ data: { id: "995607", phone: "9995600007", name: "Refund Target 3", collegeId: "col1" } });
    const o = await makeOrder("995607-ORD1", stu.id, "col1");

    await auth.createSession({ mode: "staff", staffId: mgr.id, role: 2, epoch: 0 });
    const r = await orders.refundOrder(o.id, 50, "cash", "test");
    expect(r.ok).toBe(true);
  });
});
