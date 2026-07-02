/* Razorpay webhook — payment.captured marks the order paid, stores gatewayRef,
   and triggers the same GST invoice logic as any UPI payment.
   Configure RAZORPAY_WEBHOOK_SECRET when the gateway goes live; until then the
   endpoint safely rejects everything. */
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { createInvoice, shouldInvoice } from "@/lib/money";
import { publish, orderChannels } from "@/lib/realtime";
import { pushNotif } from "@/lib/notify";

export async function POST(req: Request) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return new Response("gateway not configured", { status: 503 });

  const body = await req.text();
  const sig = req.headers.get("x-razorpay-signature") || "";
  const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
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

  const updated = await db.$transaction(async (tx) => {
    await tx.payment.create({ data: { method: "upi", amount: Number(o.total) - Number(o.creditApplied), orderId: o.id, collegeId: o.collegeId, studentId: o.studentId, gatewayRef } });
    const paymentMethod = Number(o.creditApplied) > 0 ? "upi+credit" : "upi";
    const u = await tx.order.update({ where: { id: o.id }, data: { paid: true, paymentMethod } });
    if (shouldInvoice(paymentMethod)) await createInvoice(tx, u, paymentMethod);
    return u;
  });

  await pushNotif(o.studentId, `Payment received for order #${o.id.slice(-4)} — thank you!`, "status");
  publish(orderChannels(updated), { type: "order.updated", payload: { orderId: o.id } });
  return Response.json({ ok: true });
}
