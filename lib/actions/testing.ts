"use server";
/* TEST-ONLY tools, all gated behind TEST_TOOLS=on. These let you exercise the
   real login and online-payment flows before SMS-Gate / Razorpay are wired.

   ⚠️ REMOVE BEFORE PUBLIC LAUNCH: delete the TEST_TOOLS env var (both actions
   then hard-fail) — an OTP viewer and a simulate-pay button must never be live
   for real students. */
import { db } from "../db";
import { requireStaff, requireStudent } from "../auth";
import { payOrder } from "./orders";
import { audit } from "../notify";

function testToolsOn() {
  return process.env.TEST_TOOLS === "on";
}

/* ---- Owner: peek at pending OTP codes (so any number can be tested) ---- */
export async function peekOtps() {
  if (!testToolsOn()) return { ok: false as const, error: "Test tools are off" };
  await requireStaff(4); // Owner only
  const rows = await db.otp.findMany({
    where: { usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: "desc" },
    take: 12,
    select: { phone: true, code: true, purpose: true, expiresAt: true },
  });
  return {
    ok: true as const,
    otps: rows.map((r) => ({
      phone: r.phone,
      code: r.code,
      purpose: r.purpose,
      // seconds until it expires (TTL is 5 min from creation)
      expiresInSec: Math.max(0, Math.round((r.expiresAt.getTime() - Date.now()) / 1000)),
    })),
  };
}

/* ---- Customer: settle an order as if the online gateway confirmed it ----
   Runs the EXACT same money path as a real Razorpay payment (payOrder → invoice
   rules → realtime), so what you test is what production does — minus the actual
   card charge. */
export async function simulateGatewayPayment(orderId: string, applyCredits: boolean) {
  if (!testToolsOn()) return { ok: false as const, error: "Test tools are off" };
  const stu = await requireStudent();

  const o = await db.order.findUnique({ where: { id: orderId } });
  if (!o) return { ok: false as const, error: "Order not found" };
  if (o.studentId !== stu.id) return { ok: false as const, error: "Not your order" };
  if (o.paid) return { ok: false as const, error: "Already paid" };

  await audit("TEST simulated online payment", `#${o.id.slice(-4)} ₹${Number(o.total)}`, "test");
  return payOrder(orderId, "upi", applyCredits, "TEST_SIMULATED");
}
