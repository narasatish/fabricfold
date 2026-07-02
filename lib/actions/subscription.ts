"use server";
/* Subscription: customer requests -> Manager+ activates (cash OTP / UPI).
   Cycle-based; consumption happens in acceptOrder. Renewal reminder <=30 days. */
import { db } from "../db";
import { requireStudent, requireStaff } from "../auth";
import { publish } from "../realtime";
import { pushNotif, audit } from "../notify";

const rid = (n: number) => { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; };

export async function requestSubscription(method: "cash" | "upi") {
  const stu = await requireStudent();
  const feat = stu.college.features as Record<string, boolean>;
  if (feat.subscriptions === false) return { ok: false as const, error: "Subscriptions aren't offered at your campus" };
  if (stu.subscription?.active) return { ok: false as const, error: "You already have an active plan" };
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const plan = cfg.plan as { price: number; cycles: number; kgPerCycle: number };

  await db.subscription.upsert({
    where: { studentId: stu.id },
    create: { studentId: stu.id, active: false, plan: "Annual Plan", cyclesTotal: plan.cycles, kgPerCycle: plan.kgPerCycle },
    update: { active: false, plan: "Annual Plan", cyclesTotal: plan.cycles, cyclesUsed: 0, kgPerCycle: plan.kgPerCycle },
  });
  const code = rid(4);
  await db.otp.deleteMany({ where: { purpose: "subscription", refId: stu.id } });
  await db.otp.create({ data: { phone: stu.phone, purpose: "subscription", code, refId: stu.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
  publish([`orders:${stu.collegeId}`], { type: "subscription", payload: { studentId: stu.id, method } });
  return { ok: true as const, code: method === "cash" ? code : undefined };
}

/** Manager+ activates after payment is confirmed (cash: student shows OTP; upi: payment seen). */
export async function activateSubscription(studentId: string, method: "cash" | "upi", otpCode?: string) {
  const st = await requireStaff(2); // Manager+ only
  const stu = await db.student.findUniqueOrThrow({ where: { id: studentId }, include: { subscription: true } });
  if (!stu.subscription) return { ok: false as const, error: "No pending subscription request" };

  if (method === "cash") {
    const otp = await db.otp.findFirst({ where: { purpose: "subscription", refId: studentId, usedAt: null } });
    if (!otp || (otpCode || "").trim() !== otp.code) return { ok: false as const, error: "OTP does not match" };
    await db.otp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
  }

  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const plan = cfg.plan as { price: number; cycles: number; kgPerCycle: number };
  const gstPct = Number(cfg.gstPct);
  const gross = plan.price + Math.round(plan.price * gstPct / 100);

  await db.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { studentId },
      data: { active: true, startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000), cyclesTotal: plan.cycles, cyclesUsed: 0, kgPerCycle: plan.kgPerCycle },
    });
    await tx.payment.create({ data: { method, amount: gross, collegeId: stu.collegeId, studentId, note: "Annual subscription" } });
  });

  await pushNotif(studentId, `Your annual plan is active — ${plan.cycles} cycles, up to ${plan.kgPerCycle} kg each. Happy washing!`, "status");
  await audit("Subscription activated", `${stu.name} · ₹${gross} (${method})`, st.id);
  publish([`student:${studentId}`, `orders:${stu.collegeId}`], { type: "subscription", payload: { studentId } });
  return { ok: true as const };
}

export async function cancelSubscriptionRequest() {
  const stu = await requireStudent();
  if (stu.subscription && !stu.subscription.active) {
    await db.cycleUse.deleteMany({ where: { subscriptionId: stu.subscription.id } });
    await db.subscription.delete({ where: { id: stu.subscription.id } });
    await db.otp.deleteMany({ where: { purpose: "subscription", refId: stu.id } });
  }
  return { ok: true as const };
}
