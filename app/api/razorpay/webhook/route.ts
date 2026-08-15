/* Razorpay webhook — payment.captured marks the order paid, stores gatewayRef,
   and triggers the same GST invoice logic as any UPI payment.
   Configure RAZORPAY_WEBHOOK_SECRET when the gateway goes live; until then the
   endpoint safely rejects everything. */
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { createInvoice, shouldInvoiceOrder } from "@/lib/money";
import { publish, orderChannels } from "@/lib/realtime";
import { pushNotif } from "@/lib/notify";

export async function POST(req: Request) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return new Response("gateway not configured", { status: 503 });

  const body = await req.text();
  const sig = req.headers.get("x-razorpay-signature") || "";
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  // timingSafeEqual THROWS on a length mismatch, so a malformed/absent signature
  // would 500 instead of 400. Compare lengths first, then constant-time.
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return new Response("bad signature", { status: 400 });
  }

  const ev = JSON.parse(body);
  if (ev.event !== "payment.captured") return Response.json({ ok: true });

  const p = ev.payload?.payment?.entity;
  const orderId: string | undefined = p?.notes?.ff_order_id;
  const gatewayRef: string | undefined = p?.id;
  if (!orderId) return Response.json({ ok: true });

  const o = await db.order.findUnique({ where: { id: orderId } });
  if (!o || o.paid) return Response.json({ ok: true });

  /* Razorpay RETRIES this webhook, and two retries can arrive at once. The
     `o.paid` check above is a cheap early exit, not a guarantee: it reads
     outside the transaction, so both deliveries can pass it. The real defence
     is the unique index on Payment.gatewayRef — the second insert fails, and
     since Payment rows are immutable a duplicate could never be cleaned up. */
  let updated;
  try {
    updated = await db.$transaction(async (tx) => {
      // re-read inside the transaction so the common case exits cleanly
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: o.id } });
      if (fresh.paid) return null;
      await tx.payment.create({ data: { method: "upi", amount: Number(fresh.total) - Number(fresh.creditApplied), orderId: fresh.id, collegeId: fresh.collegeId, studentId: fresh.studentId, gatewayRef } });
      const paymentMethod = Number(fresh.creditApplied) > 0 ? "upi+credit" : "upi";
      const u = await tx.order.update({ where: { id: fresh.id }, data: { paid: true, paymentMethod } });
      if (shouldInvoiceOrder(u, paymentMethod)) await createInvoice(tx, u, paymentMethod);
      return u;
    });
  } catch (e) {
    /* P2002 = the unique index rejected it, i.e. this exact gateway payment is
       already recorded. That is a SUCCESS from Razorpay's point of view, so
       answer 200: a 500 here would make it retry the same duplicate forever. */
    if ((e as { code?: string }).code === "P2002") return Response.json({ ok: true, duplicate: true });
    throw e;
  }
  if (!updated) return Response.json({ ok: true, duplicate: true });

  await pushNotif(o.studentId, `Payment received for order #${o.id.slice(-4)} — thank you!`, "status");
  publish(orderChannels(updated), { type: "order.updated", payload: { orderId: o.id } });
  return Response.json({ ok: true });
}
