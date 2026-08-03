"use server";
/* Per-college subscription plans.
   Colleges define their own plans (Admin), each bundling one or more service
   "buckets" (e.g. 20 Wash&Fold + 14 Wash&Iron). Students see and request only
   their college's plans; Manager+ activates (cash OTP / UPI) or assigns
   directly. Cycle consumption per-bucket happens in acceptOrder. */
import { db } from "../db";
import { requireStudent, requireStaff } from "../auth";
import { publish } from "../realtime";
import { pushNotif, audit } from "../notify";
import { notifyOwner } from "../mail";
import { assignWashDay } from "../washday-server";

const rid = (n: number) => { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; };

type PlanBucket = { service: string; cycles: number; kgPerCycle: number };

async function planGross(plan: { price: unknown; gstFree: boolean }) {
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const gstOn = (cfg.settings as Record<string, unknown>)?.gstEnabled !== false && !plan.gstFree;
  const price = Number(plan.price);
  return price + (gstOn ? Math.round(price * Number(cfg.gstPct) / 100) : 0);
}

function usageBuckets(buckets: PlanBucket[]) {
  return buckets.map((b) => ({ service: b.service, cycles: b.cycles, used: 0, kgPerCycle: b.kgPerCycle }));
}

/** Student requests a specific plan from their college's list. */
export async function requestSubscription(planId: string, method: "cash" | "upi") {
  const stu = await requireStudent();
  const feat = stu.college.features as Record<string, boolean>;
  if (feat.subscriptions === false) return { ok: false as const, error: "Subscriptions aren't offered at your campus" };
  if (stu.subscription?.active) return { ok: false as const, error: "You already have an active plan" };

  const plan = await db.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.active || plan.collegeId !== stu.collegeId) return { ok: false as const, error: "That plan isn't available at your campus" };
  const buckets = usageBuckets(plan.buckets as unknown as PlanBucket[]);
  const cyclesTotal = buckets.reduce((s, b) => s + b.cycles, 0);

  await db.subscription.upsert({
    where: { studentId: stu.id },
    create: { studentId: stu.id, active: false, plan: plan.name, planId: plan.id, buckets, cyclesTotal, kgPerCycle: buckets[0]?.kgPerCycle ?? 7 },
    update: { active: false, plan: plan.name, planId: plan.id, buckets, cyclesTotal, cyclesUsed: 0, kgPerCycle: buckets[0]?.kgPerCycle ?? 7 },
  });
  const code = rid(4);
  await db.otp.deleteMany({ where: { purpose: "subscription", refId: stu.id } });
  await db.otp.create({ data: { phone: stu.phone, purpose: "subscription", code, refId: stu.id, expiresAt: new Date(Date.now() + 7 * 86_400_000) } });
  publish([`orders:${stu.collegeId}`], { type: "subscription", payload: { studentId: stu.id, method } });
  void notifyOwner("New subscription request", `${stu.name} (${stu.college.name}) wants "${plan.name}" — paying by ${method.toUpperCase()}. Approve it in the staff app.`);
  return { ok: true as const, code: method === "cash" ? code : undefined };
}

/** Manager+ activates a pending request after payment is confirmed. */
export async function activateSubscription(studentId: string, method: "cash" | "upi", otpCode?: string) {
  const st = await requireStaff(2); // Manager+ only
  const stu = await db.student.findUniqueOrThrow({ where: { id: studentId }, include: { subscription: { include: { planRef: true } } } });
  if (!stu.subscription) return { ok: false as const, error: "No pending subscription request" };

  // Safety net for students registered before wash-day allocation existed:
  // give them one now, based on current burden, WITHOUT touching anyone
  // else's already-assigned day.
  if (stu.washDay === null) await assignWashDay(stu.id, stu.collegeId);

  if (method === "cash") {
    const otp = await db.otp.findFirst({ where: { purpose: "subscription", refId: studentId, usedAt: null } });
    if (!otp || (otpCode || "").trim() !== otp.code) return { ok: false as const, error: "OTP does not match" };
    await db.otp.update({ where: { id: otp.id }, data: { usedAt: new Date() } });
  }

  const planRef = stu.subscription.planRef;
  const gross = planRef
    ? await planGross(planRef)
    : await (async () => { // legacy fallback: global plan from config
        const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
        const p = cfg.plan as { price: number };
        const gstOn = (cfg.settings as Record<string, unknown>)?.gstEnabled !== false;
        return p.price + (gstOn ? Math.round(p.price * Number(cfg.gstPct) / 100) : 0);
      })();

  await db.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { studentId },
      data: { active: true, startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000), cyclesUsed: 0 },
    });
    await tx.payment.create({ data: { method, amount: gross, collegeId: stu.collegeId, studentId, note: `Subscription: ${stu.subscription!.plan}` } });
  });

  await pushNotif(studentId, `Your "${stu.subscription.plan}" plan is active. Happy washing!`, "status");
  await audit("Subscription activated", `${stu.name} · ${stu.subscription.plan} · ₹${gross} (${method})`, st.id);
  void notifyOwner("Subscription activated", `${stu.name}: "${stu.subscription.plan}" — ₹${gross} received by ${method.toUpperCase()} (activated by ${st.name}).`);
  publish([`student:${studentId}`, `orders:${stu.collegeId}`], { type: "subscription", payload: { studentId } });
  return { ok: true as const };
}

/** Manager+ assigns a plan DIRECTLY (no request/OTP; payment taken at counter). */
export async function assignSubscription(studentId: string, planId: string, method: "cash" | "upi") {
  const st = await requireStaff(2); // Manager+ only
  const stu = await db.student.findUnique({ where: { id: studentId }, include: { subscription: true } });
  if (!stu) return { ok: false as const, error: "Student not found" };
  if (stu.subscription?.active) return { ok: false as const, error: "This student already has an active plan" };

  // Same safety net as activateSubscription — only fills a MISSING wash day,
  // never reassigns an existing one.
  if (stu.washDay === null) await assignWashDay(stu.id, stu.collegeId);

  const plan = await db.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.active) return { ok: false as const, error: "Pick a plan" };
  if (plan.collegeId !== stu.collegeId) return { ok: false as const, error: "That plan belongs to a different campus" };

  const buckets = usageBuckets(plan.buckets as unknown as PlanBucket[]);
  const cyclesTotal = buckets.reduce((s, b) => s + b.cycles, 0);
  const gross = await planGross(plan);

  await db.$transaction(async (tx) => {
    await tx.subscription.upsert({
      where: { studentId },
      create: { studentId, active: true, plan: plan.name, planId: plan.id, buckets, startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000), cyclesTotal, kgPerCycle: buckets[0]?.kgPerCycle ?? 7 },
      update: { active: true, plan: plan.name, planId: plan.id, buckets, startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000), cyclesTotal, cyclesUsed: 0, kgPerCycle: buckets[0]?.kgPerCycle ?? 7 },
    });
    await tx.payment.create({ data: { method, amount: gross, collegeId: stu.collegeId, studentId, note: `Subscription: ${plan.name} (assigned at counter)` } });
  });
  await db.otp.deleteMany({ where: { purpose: "subscription", refId: studentId } });

  await pushNotif(studentId, `Your "${plan.name}" plan is active. Happy washing!`, "status");
  await audit("Subscription assigned", `${stu.name} · ${plan.name} · ₹${gross} (${method})`, st.id);
  void notifyOwner("Subscription assigned", `${stu.name}: "${plan.name}" — ₹${gross} received by ${method.toUpperCase()} (assigned by ${st.name}).`);
  publish([`student:${studentId}`, `orders:${stu.collegeId}`], { type: "subscription", payload: { studentId } });
  return { ok: true as const };
}

/* Move a student to a different plan mid-term, paying only the difference.

   Cycles already used are NOT wiped — that would hand back washes they've had.
   The new plan's buckets are rebuilt and the old usage replayed onto them, so a
   student who used 8 Wash&Fold keeps having used 8. Where the new plan has
   fewer cycles of a service than they've already spent, the bucket is simply
   full rather than negative.

   Only ever charges the difference, and never refunds a downgrade — that's a
   counter conversation, not something to automate. */
export async function upgradeSubscription(studentId: string, planId: string, method: "cash" | "upi") {
  const st = await requireStaff(2); // Manager+ — money changes hands
  const stu = await db.student.findUnique({
    where: { id: studentId },
    include: { subscription: { include: { planRef: true } } },
  });
  if (!stu) return { ok: false as const, error: "Student not found" };
  const cur = stu.subscription;
  if (!cur || !cur.active) return { ok: false as const, error: "This student has no active plan to change" };
  if (cur.expiresAt && cur.expiresAt.getTime() < Date.now()) {
    return { ok: false as const, error: "That plan has expired — assign a fresh one instead" };
  }

  const plan = await db.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.active) return { ok: false as const, error: "Pick a plan" };
  if (plan.collegeId !== stu.collegeId) return { ok: false as const, error: "That plan belongs to a different campus" };
  if (cur.planId === plan.id) return { ok: false as const, error: "They're already on that plan" };

  const oldGross = cur.planRef ? await planGross(cur.planRef) : 0;
  const newGross = await planGross(plan);
  const difference = newGross - oldGross;
  if (difference <= 0) {
    return { ok: false as const, error: "That plan isn't more expensive — handle a downgrade at the counter" };
  }

  // Rebuild buckets on the new plan, carrying the old usage across.
  type Used = { service: string; cycles: number; used: number; kgPerCycle: number };
  const oldBuckets = (cur.buckets as unknown as Used[] | null) || [];
  const usedByService = new Map<string, number>();
  for (const b of oldBuckets) usedByService.set(b.service, (usedByService.get(b.service) || 0) + b.used);

  let buckets = usageBuckets(plan.buckets as unknown as PlanBucket[]).map((b) => ({
    ...b,
    used: Math.min(b.cycles, usedByService.get(b.service) || 0),
  }));

  // A legacy subscription has no per-service buckets, so the map above is empty
  // and every bucket would come out unused — handing the student back every
  // cycle they had already spent. Spend their old total across the new buckets
  // instead, so a plan change can never be a free reset.
  if (!oldBuckets.length && cur.cyclesUsed > 0) {
    let toSpend = cur.cyclesUsed;
    buckets = buckets.map((b) => {
      const take = Math.min(b.cycles, toSpend);
      toSpend -= take;
      return { ...b, used: take };
    });
  }

  const cyclesTotal = buckets.reduce((s, b) => s + b.cycles, 0);
  const cyclesUsed = buckets.reduce((s, b) => s + b.used, 0);

  await db.$transaction(async (tx) => {
    await tx.subscription.update({
      where: { studentId },
      data: {
        plan: plan.name, planId: plan.id, buckets, cyclesTotal, cyclesUsed,
        kgPerCycle: buckets[0]?.kgPerCycle ?? Number(cur.kgPerCycle),
      },
    });
    await tx.payment.create({
      data: { method, amount: difference, collegeId: stu.collegeId, studentId, note: `Plan change: ${cur.plan} → ${plan.name}` },
    });
  });

  await pushNotif(studentId, `You're now on the "${plan.name}" plan. ${cyclesTotal - cyclesUsed} cycles left.`, "status");
  await audit("Plan changed", `${stu.name} · ${cur.plan} → ${plan.name} · ₹${difference} (${method})`, st.id);
  void notifyOwner("Plan changed", `${stu.name}: ${cur.plan} → ${plan.name}. Collected ₹${difference} by ${method.toUpperCase()} (by ${st.name}).`);
  publish([`student:${studentId}`, `orders:${stu.collegeId}`], { type: "subscription", payload: { studentId } });
  return { ok: true as const, difference, cyclesLeft: cyclesTotal - cyclesUsed, tierChanged: cur.planRef?.tier !== plan.tier };
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
