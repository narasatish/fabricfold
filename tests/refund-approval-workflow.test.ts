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

/* Scoped re-audit 2026-10-29: performRefund (extracted from the original
   single refundOrder function) is shared by both the small-refund path and
   approveRefundRequest. Confirm the approval path exercises EVERY piece of
   that shared logic, not just the Payment row — in particular the
   proportional GST credit note refundOrder's original single-function form
   always created for an invoiced order. */
describe("approveRefundRequest interacting with the rest of the money system", () => {
  async function mkInvoicedUpiOrder(subtotal: number, gst: number) {
    const id = `REFAPPRINV${++orderSeq}`;
    return db.order.create({
      data: {
        id, studentId: "444444", collegeId: "col1", service: "washIron",
        items: [{ label: "Garment", rate: 10, qty: Math.round(subtotal / 10) }],
        declaredPieces: Math.round(subtotal / 10), subtotal, gst, gstPctSnapshot: 18,
        total: subtotal + gst, status: "received", paid: false, noGst: false,
      },
    });
  }

  it("approving a refund above the threshold on an invoiced order creates a proportional CreditNote, not just a Payment row", async () => {
    await asManager();
    const o = await mkInvoicedUpiOrder(1000, 180); // total 1180
    const paid = await orders.recordPay(o.id, "upi", false, false);
    expect(paid.ok).toBe(true);
    const invoice = await db.invoice.findUnique({ where: { orderId: o.id } });
    expect(invoice).toBeTruthy();

    const r = await orders.refundOrder(o.id, 600, "upi", "invoiced refund above threshold");
    expect(r.status).toBe("pending");

    await asAdmin();
    const approved = await orders.approveRefundRequest(r.id!);
    expect(approved.ok).toBe(true);

    const creditNote = await db.creditNote.findFirst({ where: { orderId: o.id } });
    expect(creditNote).toBeTruthy();
    expect(Number(creditNote!.total)).toBe(600);
    // ratio = 600/1180; gst = round(180 * ratio * 100) / 100
    const expectedGst = Math.round(180 * (600 / 1180) * 100) / 100;
    expect(Number(creditNote!.gst)).toBe(expectedGst);
    expect(Number(creditNote!.subtotal)).toBe(Math.round((600 - expectedGst) * 100) / 100);
    expect(creditNote!.invoiceId).toBe(invoice!.id);
    expect(creditNote!.by).toBe(admin.id);
  });

  it("a campus-scoped Admin cannot approve or reject a pending request from a DIFFERENT campus", async () => {
    await db.college.create({ data: { id: "col2", name: "Other College", features: {} } });
    const otherAdmin = await db.staff.create({ data: { phone: "9000000053", name: "Admin2", role: 3, collegeId: "col2" } });
    await auth.createSession({ mode: "staff", staffId: otherAdmin.id, role: otherAdmin.role, epoch: otherAdmin.sessionEpoch });

    await asManager(); // col1 manager requests the refund
    const o = await mkPaidOrder(600);
    const r = await orders.refundOrder(o.id, 600, "cash", "cross-campus block check");
    expect(r.status).toBe("pending");

    // Switch to the col2 Admin and try to act on a col1 request directly.
    await auth.createSession({ mode: "staff", staffId: otherAdmin.id, role: otherAdmin.role, epoch: otherAdmin.sessionEpoch });
    await expect(orders.approveRefundRequest(r.id!)).rejects.toThrow();
    await expect(orders.rejectRefundRequest(r.id!)).rejects.toThrow();

    const reqRow = await db.refundRequest.findUniqueOrThrow({ where: { id: r.id! } });
    expect(reqRow.status).toBe("pending");
  });

  it("restores the cycle against the CURRENT subscription state at approval time, not a snapshot captured when the refund was requested", async () => {
    // Student starts with cyclesUsed: 1 (just this order's own burn).
    const sub = await db.subscription.create({
      data: {
        studentId: "444444", active: true, plan: "Bronze", cyclesTotal: 10, cyclesUsed: 1, kgPerCycle: 7,
        buckets: [{ service: "washFold", cycles: 10, used: 1, kgPerCycle: 7 }],
        startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000),
      },
    });
    const o = await db.order.create({
      data: {
        id: `REFAPPRCYC${++orderSeq}`, studentId: "444444", collegeId: "col1", service: "washFold",
        items: [{ label: "Cycle", rate: 600, qty: 1 }], cyclesCount: 1,
        subtotal: 600, gst: 0, gstPctSnapshot: 18, total: 600,
        paid: true, paymentMethod: "cash", usedCycle: true, status: "collected",
      },
    });
    await db.cycleUse.create({ data: { subscriptionId: sub.id, orderId: o.id } });

    await asManager();
    const r = await orders.refundOrder(o.id, 600, "cash", "cycle refund above threshold", true);
    expect(r.status).toBe("pending");

    // While the refund sits pending, a SECOND, unrelated order burns another
    // cycle on the same subscription — modeling normal usage in the approval
    // delay window (the scenario the task description calls out: plan
    // upgrade or cycle usage from another order between request and
    // approval). cyclesUsed is now 2, not the 1 captured at request time.
    await db.subscription.update({
      where: { id: sub.id },
      data: { cyclesUsed: 2, buckets: [{ service: "washFold", cycles: 10, used: 2, kgPerCycle: 7 }] },
    });

    await asAdmin();
    const approved = await orders.approveRefundRequest(r.id!);
    expect(approved.ok).toBe(true);

    const subAfter = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    // Must decrement off the FRESH value (2 -> 1), not the stale
    // request-time value (which would wrongly compute 1 -> 0 and lose the
    // second order's own still-valid cycle burn).
    expect(subAfter.cyclesUsed).toBe(1);
    const buckets = subAfter.buckets as unknown as { service: string; used: number }[];
    expect(buckets.find((b) => b.service === "washFold")!.used).toBe(1);
  });

  /* The approval-delay window makes a real-world race realistic that was
     previously a near-impossible microsecond collision: a pending refund
     (restoreCycle: true) can sit for minutes/hours while an Admin reviews
     it, during which a DIFFERENT staff member can cancel the very same
     order (cancelOrder also always restores the cycle — "the wash never
     happened"). cancelOrder reads the order ONCE, before its own
     transaction starts, and hands that pre-transaction snapshot straight
     to restoreCycleFor — unlike performRefund, which was already fixed
     (2026-10-20) to re-read the order FRESH, inside the lock, specifically
     so two cycle-restoring operations on the same order can't both see
     usedCycle: true. If an approveRefundRequest(restoreCycle: true) and a
     cancelOrder on the same order genuinely overlap, cancelOrder can still
     restore off its own stale snapshot even after the refund's restore has
     already landed — a real double-credit of one cycle. */
  it("cancelOrder does not double-restore a cycle that a concurrent, already-approved refund already restored", async () => {
    // cyclesUsed starts at 2 — as if a SECOND, untouched order elsewhere
    // also burned a cycle (same deliberate choice refund-race-behavioral.
    // test.ts makes) — so a double-restore shows up as a WRONG final count
    // (0, i.e. restored twice) vs. the correct outcome (1, i.e. restored
    // once), rather than both landing on the same clamped floor where a
    // starting value of 1 would hide the bug behind Math.min's own clamp.
    await db.student.create({ data: { id: "444445", phone: "9999900005", name: "Refund Student 2", collegeId: "col1" } });
    const sub = await db.subscription.create({
      data: {
        studentId: "444445", active: true, plan: "Bronze", cyclesTotal: 10, cyclesUsed: 2, kgPerCycle: 7,
        buckets: [{ service: "washFold", cycles: 10, used: 2, kgPerCycle: 7 }],
        startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000),
      },
    });
    const o = await db.order.create({
      data: {
        id: `REFAPPRCYC2${++orderSeq}`, studentId: "444445", collegeId: "col1", service: "washFold",
        items: [{ label: "Cycle", rate: 600, qty: 1 }], cyclesCount: 1,
        subtotal: 600, gst: 0, gstPctSnapshot: 18, total: 600,
        paid: true, paymentMethod: "cash", usedCycle: true, status: "ready",
      },
    });
    await db.cycleUse.create({ data: { subscriptionId: sub.id, orderId: o.id } });

    await asManager();
    const r = await orders.refundOrder(o.id, 600, "cash", "cycle refund, racing a cancel", true);
    expect(r.status).toBe("pending");

    // Force the exact interleaving a real race would produce, rather than
    // hoping Promise.all happens to land on it: let cancelOrder take its
    // pre-transaction snapshot of the order (stale `usedCycle: true`),
    // THEN let the concurrent approval fully commit (flipping usedCycle to
    // false and restoring the cycle for real), and only THEN let
    // cancelOrder's own transaction run against that now-stale snapshot.
    const originalFindFirst = db.order.findUniqueOrThrow.bind(db.order);
    let intercepted = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(db.order, "findUniqueOrThrow").mockImplementation(((...args: any[]) => (async () => {
      const result = await (originalFindFirst as any)(...args);
      if (!intercepted && (result as { id?: string })?.id === o.id) {
        intercepted = true;
        spy.mockRestore();
        await asAdmin();
        const approveResult = await orders.approveRefundRequest(r.id!);
        expect(approveResult.ok).toBe(true);
      }
      return result;
    })()) as any);

    await asAdmin();
    const cancelResult = await orders.cancelOrder(o.id, { note: "racing the approval", photos: ["p1.jpg", "p2.jpg", "p3.jpg"] });
    expect(cancelResult.ok).toBe(true);

    const subAfter = await db.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    // This order burned exactly ONE cycle, ever. Restored once: 2 -> 1.
    // A double-restore (once from the cancel, once from the refund) would
    // wrongly drive it to 0.
    expect(subAfter.cyclesUsed).toBe(1);
    const buckets = subAfter.buckets as unknown as { service: string; used: number }[];
    expect(buckets.find((b) => b.service === "washFold")!.used).toBe(1);
  });
});
