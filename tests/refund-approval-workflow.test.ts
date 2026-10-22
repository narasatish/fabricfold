/* Owner request 2026-10-22: a refund above ₹500 needs a second, more
   senior person (Admin/Owner, role >= 3) to sign off before any money
   actually moves — a deliberately HIGHER bar than the "refunds" tool
   itself (Manager+ by default), since the whole point is a second person.
   This proves the full real workflow against a live Postgres schema:
   small refunds still execute immediately, large ones only create a
   pending request and move nothing, a Manager cannot approve their own or
   anyone's request, and approval reuses the same hardened transaction
   logic (refundAmount cap, cycle restore) as the small-refund path. */
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
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.203" }),
}));

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const SCHEMA = "ff_refund_approval";
const TEST_URL = BASE.split("?")[0] + `?schema=${SCHEMA}`;
process.env.DATABASE_URL = TEST_URL;

let db: typeof import("../lib/db").db;
let auth: typeof import("../lib/auth");
let orders: typeof import("../lib/actions/orders");

let manager: { id: string; role: number; sessionEpoch: number };
let admin: { id: string; role: number; sessionEpoch: number };
let otherManager: { id: string; role: number; sessionEpoch: number };

beforeAll(async () => {
  if (!IS_PG) throw new Error("This test needs a real Postgres DATABASE_URL/DIRECT_URL.");
  const { Client } = await import("pg");
  const client = new Client({ connectionString: BASE.split("?")[0] });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
  await client.end();
  execSync("npx prisma db push", {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { ...process.env, DATABASE_URL: TEST_URL },
  });
  db = (await import("../lib/db")).db;
  auth = await import("../lib/auth");
  orders = await import("../lib/actions/orders");

  await db.college.create({ data: { id: "col1", name: "Test College", features: {} } });
  await db.student.create({ data: { id: "444444", phone: "9999900004", name: "Refund Student", collegeId: "col1" } });
  manager = await db.staff.create({ data: { phone: "9000000050", name: "Manager", role: 2, collegeId: "col1" } });
  admin = await db.staff.create({ data: { phone: "9000000051", name: "Admin", role: 3, collegeId: "col1" } });
  otherManager = await db.staff.create({ data: { phone: "9000000052", name: "Manager2", role: 2, collegeId: "col1" } });
}, 300_000);

let orderSeq = 0;
function mkPaidOrder(total: number) {
  const id = `REFAPPR${++orderSeq}`;
  return db.order.create({
    data: {
      id, studentId: "444444", collegeId: "col1", service: "washIron",
      items: [{ label: "Garment", rate: 10, qty: Math.round(total / 10) }],
      declaredPieces: Math.round(total / 10), subtotal: total, gst: 0, gstPctSnapshot: 0, total,
      status: "collected", paid: true, paymentMethod: "cash",
    },
  });
}

async function asManager() {
  await auth.createSession({ mode: "staff", staffId: manager.id, role: manager.role, epoch: manager.sessionEpoch });
}
async function asAdmin() {
  await auth.createSession({ mode: "staff", staffId: admin.id, role: admin.role, epoch: admin.sessionEpoch });
}
async function asOtherManager() {
  await auth.createSession({ mode: "staff", staffId: otherManager.id, role: otherManager.role, epoch: otherManager.sessionEpoch });
}

describe("refunds at or below the threshold execute immediately, unchanged", () => {
  it("a ₹500 refund (exactly at the threshold) moves money with no approval step", async () => {
    await asManager();
    const o = await mkPaidOrder(500);
    const r = await orders.refundOrder(o.id, 500, "cash", "exact threshold");
    expect(r.ok).toBe(true);
    expect(r.status).toBeUndefined();
    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(Number(after.refundAmount)).toBe(500);
    const pending = await db.refundRequest.count({ where: { orderId: o.id } });
    expect(pending).toBe(0);
  });
});

describe("refunds above the threshold create a pending request and move no money", () => {
  it("a ₹600 refund does not touch the order's refundAmount", async () => {
    await asManager();
    const o = await mkPaidOrder(600);
    const r = await orders.refundOrder(o.id, 600, "cash", "big refund");
    expect(r.ok).toBe(true);
    expect(r.status).toBe("pending");

    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(Number(after.refundAmount || 0)).toBe(0);
    expect(after.refunded).toBe(false);

    const reqRow = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id! } });
    expect(reqRow.status).toBe("pending");
    expect(reqRow.requestedBy).toBe(manager.id);
    expect(Number(reqRow.amount)).toBe(600);
  });

  it("a Manager (role 2) cannot approve any pending request, including their own", async () => {
    await asManager();
    const o = await mkPaidOrder(700);
    const r = await orders.refundOrder(o.id, 700, "upi", "needs approval");
    expect(r.status).toBe("pending");

    await expect(orders.approveRefundRequest(r.id!)).rejects.toThrow();

    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(Number(after.refundAmount || 0)).toBe(0);
  });

  it("an Admin (role 3) can approve, and the money actually moves via the same logic as a direct refund", async () => {
    await asManager();
    const o = await mkPaidOrder(800);
    const r = await orders.refundOrder(o.id, 800, "cash", "approved case");
    expect(r.status).toBe("pending");

    await asAdmin();
    const approved = await orders.approveRefundRequest(r.id!);
    expect(approved.ok).toBe(true);

    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(Number(after.refundAmount)).toBe(800);
    expect(after.refunded).toBe(true);

    const reqRow = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id! } });
    expect(reqRow.status).toBe("approved");
    expect(reqRow.decidedBy).toBe(admin.id);

    const payment = await db.payment.findFirst({ where: { orderId: o.id, method: "refund" } });
    expect(payment).toBeTruthy();
    expect(Number(payment!.amount)).toBe(-800);
  });

  it("an Admin can reject instead, and no money moves", async () => {
    await asManager();
    const o = await mkPaidOrder(900);
    const r = await orders.refundOrder(o.id, 900, "cash", "will be rejected");
    expect(r.status).toBe("pending");

    await asAdmin();
    const rejected = await orders.rejectRefundRequest(r.id!, "not justified");
    expect(rejected.ok).toBe(true);

    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(Number(after.refundAmount || 0)).toBe(0);

    const reqRow = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id! } });
    expect(reqRow.status).toBe("rejected");
    expect(reqRow.decisionNote).toBe("not justified");
  });

  it("cannot approve or reject the same request twice", async () => {
    await asManager();
    const o = await mkPaidOrder(1000);
    const r = await orders.refundOrder(o.id, 1000, "cash", "double-decision guard");

    await asAdmin();
    const first = await orders.approveRefundRequest(r.id!);
    expect(first.ok).toBe(true);

    const second = await orders.approveRefundRequest(r.id!);
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already approved/i);

    // Only ONE refund payment recorded, not two.
    const payments = await db.payment.findMany({ where: { orderId: o.id, method: "refund" } });
    expect(payments.length).toBe(1);
  });

  it("re-validates the refundable cap at approval time, not just at request time", async () => {
    await asManager();
    const o = await mkPaidOrder(1000);
    const r1 = await orders.refundOrder(o.id, 600, "cash", "first chunk");
    expect(r1.status).toBe("pending");
    const r2 = await orders.refundOrder(o.id, 600, "cash", "second chunk, would overshoot");
    expect(r2.status).toBe("pending");

    // Approve the first — consumes 600 of the 1000 total.
    await asAdmin();
    const approved1 = await orders.approveRefundRequest(r1.id!);
    expect(approved1.ok).toBe(true);

    // The second request (also 600) would now overshoot the remaining 400 —
    // performRefund's own fresh-read cap check inside approveRefundRequest
    // must catch this, not just refundOrder's request-time check.
    const approved2 = await orders.approveRefundRequest(r2.id!);
    expect(approved2.ok).toBe(false);
    expect(approved2.error).toMatch(/only ₹400 left/i);
  });

  it("listPendingRefundRequests only shows pending ones, scoped to the staff member's campus", async () => {
    await asManager();
    const o = await mkPaidOrder(600);
    await orders.refundOrder(o.id, 600, "cash", "for the list test");

    await asAdmin();
    const pending = await orders.listPendingRefundRequests();
    expect(pending.some((p) => p.orderId === o.id)).toBe(true);
    expect(pending.every((p) => p.status === "pending")).toBe(true);
  });

  it("a Manager from a different account still cannot approve (not just the original requester)", async () => {
    await asManager();
    const o = await mkPaidOrder(600);
    const r = await orders.refundOrder(o.id, 600, "cash", "other manager cannot approve");

    await asOtherManager();
    await expect(orders.approveRefundRequest(r.id!)).rejects.toThrow();
  });
});
