/* Payment-gateway webhook tests.

   These prove the auto-confirmation path works WITHOUT needing a Razorpay
   account: we sign a payload with the same HMAC-SHA256 scheme Razorpay uses,
   POST it at the route handler, and assert the order flips to paid and a GST
   invoice is raised. Runs in the isolated ff_test schema â€” never real data. */
import "dotenv/config";
import { beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { ensureTestSchema } from "./_schema";
import path from "node:path";

const BASE = process.env.DIRECT_URL || process.env.DATABASE_URL || "";
const IS_PG = /^postgres(ql)?:\/\//.test(BASE);
const TEST_URL = IS_PG ? BASE.split("?")[0] + "?schema=ff_test" : "file:" + path.resolve(__dirname, "../test.db");
process.env.DATABASE_URL = TEST_URL;

const SECRET = "whsec_test_fabricfold";
process.env.RAZORPAY_WEBHOOK_SECRET = SECRET;

let db: typeof import("../lib/db").db;
let POST: (req: Request) => Promise<Response>;

/** Build the exact payload+signature Razorpay sends for a captured payment. */
function signedRequest(body: unknown, secretOverride?: string) {
  const raw = JSON.stringify(body);
  const sig = crypto.createHmac("sha256", secretOverride ?? SECRET).update(raw).digest("hex");
  return new Request("https://fabricfold.in/api/razorpay/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-razorpay-signature": sig },
    body: raw,
  });
}

/* The default reference is derived from the order.

   It used to be the same literal for every scenario, which modelled something
   that cannot happen: a Razorpay payment id is globally unique, so one id can
   never appear on two orders. The database now enforces exactly that, and the
   shared literal would have failed the constraint â€” the fixture was wrong, not
   the rule. A replay of ONE order still reuses its id, which is the case that
   matters and is asserted below. */
function capturedEvent(orderId: string, paymentId = `pay_TEST_${orderId}`) {
  return {
    event: "payment.captured",
    payload: { payment: { entity: { id: paymentId, notes: { ff_order_id: orderId } } } },
  };
}

beforeAll(async () => {
  db = (await import("../lib/db")).db;
  await ensureTestSchema(TEST_URL, async () => {
    /* Probe the NEWEST schema addition, not an old table: a probe that checks
       something ancient reports "current" forever and lets every later column
       drift past it — exactly how Student.kind went missing here once. */
      try { await db.waVerify.count(); await db.student.count({ where: { kind: "student" } }); return true; } catch { return false; }
  });
  ({ POST } = await import("../app/api/razorpay/webhook/route"));

  await db.appConfig.upsert({
    where: { id: "main" },
    update: {},
    create: {
      id: "main", gstPct: 18,
      plan: { price: 6800, cycles: 34, kgPerCycle: 7 },
      rates: { washIron: { label: "Wash & Iron", items: [["Regular garment", 15]] } },
      payment: {}, settings: {},
    },
  });
  await db.college.upsert({ where: { id: "gw1" }, update: {}, create: { id: "gw1", name: "Gateway College", features: {} } });
  await db.student.upsert({
    where: { id: "222222" }, update: {},
    create: { id: "222222", phone: "9999900002", name: "Gateway Student", collegeId: "gw1" },
  });

  /* Clear this file's own fixtures before creating them again.
     There was no cleanup here at all. It passed only because the schema was
     changing often enough that `prisma db push` kept truncating tables as a
     side effect â€” so the suite was green for a reason unrelated to the tests.
     The moment the schema settled, the second run failed on duplicate order
     ids. Cleaning explicitly makes the file repeatable on its own terms.

     Payments and invoices are immutable by trigger, hence the escape hatch;
     it is scoped to this transaction and to rows this file created. */
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.allow_delete = 'on'`);
    const mine = await tx.order.findMany({ where: { collegeId: "gw1" }, select: { id: true } });
    const ids = mine.map((o) => o.id);
    if (ids.length) {
      await tx.creditNote.deleteMany({ where: { invoice: { orderId: { in: ids } } } });
      await tx.invoice.deleteMany({ where: { orderId: { in: ids } } });
      await tx.payment.deleteMany({ where: { orderId: { in: ids } } });
      await tx.orderEvent.deleteMany({ where: { orderId: { in: ids } } });
      await tx.garmentTag.deleteMany({ where: { orderId: { in: ids } } });
      await tx.order.deleteMany({ where: { id: { in: ids } } });
    }
  });
  // Same reason as washday.test.ts: the slow part is `prisma db push` against a
  // remote Postgres, and it grows with the schema. It crossed the old 120s
  // budget once the Bag table landed.
}, 300_000);

async function mkOrder(id: string, opts: { noGst?: boolean; creditApplied?: number } = {}) {
  return db.order.create({
    data: {
      id, studentId: "222222", collegeId: "gw1", service: "washIron",
      items: [{ label: "Regular garment", rate: 15, qty: 10 }],
      subtotal: 150, gst: opts.noGst ? 0 : 27, gstPctSnapshot: opts.noGst ? 0 : 18,
      total: opts.noGst ? 150 : 177, noGst: !!opts.noGst,
      creditApplied: opts.creditApplied ?? 0,
    },
  });
}

describe("payment gateway webhook â€” auto-confirmation", () => {
  it("a validly signed payment.captured marks the order paid and raises a GST invoice", async () => {
    const o = await mkOrder("GWPAID01");
    const res = await POST(signedRequest(capturedEvent(o.id)));
    expect(res.status).toBe(200);

    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.paid).toBe(true);
    expect(after.paymentMethod).toBe("upi");

    // money actually recorded, tagged with the gateway's reference
    const pay = await db.payment.findFirst({ where: { orderId: o.id } });
    expect(Number(pay?.amount)).toBe(177);
    expect(pay?.gatewayRef).toBe(`pay_TEST_${o.id}`);

    // UPI => a real GST invoice, gap-free numbering
    const inv = await db.invoice.findFirst({ where: { orderId: o.id } });
    expect(inv).toBeTruthy();
    expect(inv?.number).toMatch(/^INV-\d{4}-\d{4}$/);
  });

  it("a forged signature is rejected and changes nothing", async () => {
    const o = await mkOrder("GWFORGE1");
    const res = await POST(signedRequest(capturedEvent(o.id), "wrong-secret"));
    expect(res.status).toBe(400);
    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.paid).toBe(false);
  });

  it("a malformed signature returns 400, not a 500 crash", async () => {
    // timingSafeEqual throws on length mismatch â€” this is the regression guard
    const o = await mkOrder("GWBADSIG");
    const raw = JSON.stringify(capturedEvent(o.id));
    const req = new Request("https://fabricfold.in/api/razorpay/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": "short" },
      body: raw,
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("replaying the same capture does not double-charge or double-invoice", async () => {
    const o = await mkOrder("GWREPLAY");
    await POST(signedRequest(capturedEvent(o.id)));
    await POST(signedRequest(capturedEvent(o.id)));
    expect(await db.payment.count({ where: { orderId: o.id } })).toBe(1);
    expect(await db.invoice.count({ where: { orderId: o.id } })).toBe(1);
  });

  it("a no-GST order is captured but never invoiced", async () => {
    const o = await mkOrder("GWNOGST1", { noGst: true });
    await POST(signedRequest(capturedEvent(o.id)));
    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.paid).toBe(true);
    expect(await db.invoice.count({ where: { orderId: o.id } })).toBe(0);
  });

  it("only charges the balance when wallet credit was applied", async () => {
    const o = await mkOrder("GWCREDIT", { creditApplied: 77 });
    await POST(signedRequest(capturedEvent(o.id, "pay_TEST456")));
    const pay = await db.payment.findFirst({ where: { orderId: o.id } });
    expect(Number(pay?.amount)).toBe(100); // 177 total - 77 credit
    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.paymentMethod).toBe("upi+credit");
  });

  it("ignores non-capture events", async () => {
    const res = await POST(signedRequest({ event: "payment.failed", payload: {} }));
    expect(res.status).toBe(200);
  });
});
