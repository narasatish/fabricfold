"use server";
/* Razorpay gateway — the online-payment path for customers.
   Fully built; activates automatically when RAZORPAY_KEY_ID/KEY_SECRET are set.
   Flow: createGatewayOrder() → Razorpay Checkout on the client →
   confirmGatewayPayment() verifies the signature and marks the order paid via
   the exact same money rules as every other payment (payOrder → payCore). */
import crypto from "node:crypto";
import { db } from "../db";
import { requireStudent } from "../auth";
import { payOrder } from "./orders";

const KEY_ID = () => process.env.RAZORPAY_KEY_ID || "";
const KEY_SECRET = () => process.env.RAZORPAY_KEY_SECRET || "";

export async function gatewayEnabled() {
  return !!(KEY_ID() && KEY_SECRET());
}

/** Create a Razorpay order for the amount still owed (after optional credits). */
export async function createGatewayOrder(orderId: string, applyCredits: boolean) {
  const stu = await requireStudent();
  if (!(await gatewayEnabled())) return { ok: false as const, error: "Online payment isn't available yet — pay at the counter" };

  const o = await db.order.findUniqueOrThrow({ where: { id: orderId } });
  if (o.studentId !== stu.id) return { ok: false as const, error: "Not your order" };
  if (o.paid) return { ok: false as const, error: "Already paid" };

  const total = Number(o.total);
  const credits = applyCredits ? Math.min(Number(stu.credits), total) : 0;
  const due = total - credits;
  if (due <= 0) return { ok: false as const, error: "Credits cover this bill — use 'Pay with credits' instead" };

  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${KEY_ID()}:${KEY_SECRET()}`).toString("base64"),
    },
    body: JSON.stringify({
      amount: Math.round(due * 100), // paise
      currency: "INR",
      receipt: o.id,
      notes: { ff_order_id: o.id, ff_student_id: stu.id, ff_apply_credits: applyCredits ? "1" : "0" },
    }),
  });
  if (!res.ok) {
    console.error("Razorpay order create failed:", res.status, await res.text());
    return { ok: false as const, error: "Could not start online payment — try again or pay at the counter" };
  }
  const rzp = (await res.json()) as { id: string; amount: number };
  return {
    ok: true as const,
    keyId: KEY_ID(),
    rzpOrderId: rzp.id,
    amount: rzp.amount,
    name: stu.name,
    phone: stu.phone,
  };
}

/** Verify Razorpay's signature, then settle the order through the normal rules. */
export async function confirmGatewayPayment(
  orderId: string,
  applyCredits: boolean,
  rzp: { orderId: string; paymentId: string; signature: string },
) {
  await requireStudent(); // session check; ownership is re-checked inside payOrder
  if (!(await gatewayEnabled())) return { ok: false as const, error: "Gateway not configured" };

  const expected = crypto
    .createHmac("sha256", KEY_SECRET())
    .update(`${rzp.orderId}|${rzp.paymentId}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(rzp.signature || "");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false as const, error: "Payment could not be verified" };
  }

  // Same money path as every UPI payment (credit split, invoice rules, realtime).
  return payOrder(orderId, "upi", applyCredits, rzp.paymentId);
}
