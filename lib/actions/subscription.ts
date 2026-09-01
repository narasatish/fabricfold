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
import { syncBagToPlan } from "./bags";
import { CYCLE_RATES } from "../money";
import { enqueueSheetEvent, flushSoon, istStamp } from "../sheet-events";

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

/* Students cannot buy a plan themselves — plans are sold at the counter only,
   by Manager+ (assignSubscription). Money changes hands in person, so the
   record of it has to be created by whoever took the money.

   Kept as a refusing stub rather than removed: an older client bundle still
   calling this gets a clear message instead of a crash, and because the block
   is on the SERVER it holds regardless of what the browser sends. */
export async function requestSubscription(_planId: string, _method: "cash" | "upi") {
  await requireStudent();
  return {
    ok: false as const,
    error: "Plans are activated at the counter. Visit the counter and staff will set yours up.",
  };
}

/** Manager+ activates a pending request after payment is confirmed. */
export async function activateSubscription(studentId: string, method: "cash" | "upi", otpCode?: string) {
  const st = await requireStaff(2); // Manager+ only
  const stu = await db.student.findUniqueOrThrow({ where: { id: studentId }, include: { subscription: { include: { planRef: true } } } });
  if (!stu.subscription) return { ok: false as const, error: "No pending subscription request" };

  // Safety net for students registered before wash-day allocation existed:
  // give them one now, based on current burden, WITHOUT touching anyone
  // else's already-assigned day.
  // wash-day rota parked — no day assigned on activation

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

  // Third path that turns a plan on, so it allocates the code too.
  const bag = await syncBagToPlan(studentId);

  await pushNotif(studentId, `Your "${stu.subscription.plan}" plan is active. Happy washing!`, "status");
  await audit("Subscription activated", `${stu.name} · ${stu.subscription.plan} · ₹${gross} (${method})${bag.ok && bag.code ? ` · ${bag.code}` : ""}`, st.id);
  void notifyOwner("Subscription activated", `${stu.name}: "${stu.subscription.plan}" — ₹${gross} received by ${method.toUpperCase()} (activated by ${st.name}).`);
  publish([`student:${studentId}`, `orders:${stu.collegeId}`], { type: "subscription", payload: { studentId } });
  return { ok: true as const, code: bag.ok ? bag.code : undefined, bagError: bag.ok ? undefined : bag.error };
}

/** Manager+ assigns a plan DIRECTLY (no request/OTP; payment taken at counter). */
export async function assignSubscription(studentId: string, planId: string, method: "cash" | "upi") {
  const st = await requireStaff(2); // Manager+ only
  const stu = await db.student.findUnique({ where: { id: studentId }, include: { subscription: true } });
  if (!stu) return { ok: false as const, error: "Student not found" };
  if (stu.subscription?.active) return { ok: false as const, error: "This student already has an active plan" };

  // Same safety net as activateSubscription — only fills a MISSING wash day,
  // never reassigns an existing one.
  // wash-day rota parked — no day assigned on activation

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

  /* The customer ID follows the plan. Bronze -> B###, Silver -> S###, Gold ->
     G###. Doing it here is the whole point: assigning a plan and issuing the
     bag used to be two unconnected steps, so a Silver subscriber could sit
     with no S-code at all until someone remembered the second one.

     Deliberately AFTER the payment transaction and not inside it — a paid
     subscription must not roll back because a code could not be allocated.
     A failure is reported to the caller, not thrown. */
  const bag = await syncBagToPlan(studentId);

  await pushNotif(studentId, `Your "${plan.name}" plan is active. Happy washing!`, "status");
  await audit("Subscription assigned", `${stu.name} · ${plan.name} · ₹${gross} (${method})${bag.ok && bag.code ? ` · ${bag.code}` : ""}`, st.id);
  void notifyOwner("Subscription assigned", `${stu.name}: "${plan.name}" — ₹${gross} received by ${method.toUpperCase()} (assigned by ${st.name}).`);
  publish([`student:${studentId}`, `orders:${stu.collegeId}`], { type: "subscription", payload: { studentId } });
  return { ok: true as const, code: bag.ok ? bag.code : undefined, bagError: bag.ok ? undefined : bag.error };
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

  /* A tier change changes the letter on the bag, so the code is re-issued and
     the old one retired. Free — charging a student to upgrade would be wrong,
     and issueBag already treats a tier swap as complimentary. */
  const bag = await syncBagToPlan(studentId);

  await pushNotif(studentId, `You're now on the "${plan.name}" plan. ${cyclesTotal - cyclesUsed} cycles left.`, "status");
  await audit("Plan changed", `${stu.name} · ${cur.plan} → ${plan.name} · ₹${difference} (${method})${bag.ok && bag.changed ? ` · ${bag.replaced} → ${bag.code}` : ""}`, st.id);
  void notifyOwner("Plan changed", `${stu.name}: ${cur.plan} → ${plan.name}. Collected ₹${difference} by ${method.toUpperCase()} (by ${st.name}).`);
  publish([`student:${studentId}`, `orders:${stu.collegeId}`], { type: "subscription", payload: { studentId } });
  return { ok: true as const, difference, cyclesLeft: cyclesTotal - cyclesUsed, tierChanged: cur.planRef?.tier !== plan.tier, code: bag.ok ? bag.code : undefined };
}

/* Admin cancels an active plan, for any reason, at any time.

   The reason is mandatory and stored. A plan that merely went inactive with no
   explanation is indistinguishable from a bug, and the student is owed an
   answer months later just as much as today.

   Remaining cycles are FORFEITED, consistent with expiry — cancelling is not a
   refund. Money owed back is a separate, deliberate act (compensation or
   refund), so that a cancellation can never quietly move cash on its own.

   The subscription row is kept, not deleted: cycle history, past orders and
   the audit trail all hang off it. */
export async function cancelSubscription(studentId: string, reason: string) {
  const st = await requireStaff(3); // Admin+ — this ends something the student paid for
  const note = (reason || "").trim();
  if (note.length < 3) return { ok: false as const, error: "Give a reason — it is shown to the student and kept on record" };

  const stu = await db.student.findUnique({
    where: { id: studentId },
    include: { subscription: true },
  });
  if (!stu) return { ok: false as const, error: "Student not found" };
  const sub = stu.subscription;
  if (!sub) return { ok: false as const, error: "This student has no plan" };
  if (!sub.active) return { ok: false as const, error: "That plan is already inactive" };

  const left = Math.max(0, sub.cyclesTotal - sub.cyclesUsed);

  await db.subscription.update({
    where: { studentId },
    data: { active: false, cancelledAt: new Date(), cancelledReason: note, cancelledBy: st.id },
  });

  await pushNotif(
    studentId,
    `Your "${sub.plan}" plan has been cancelled. ${note}` +
      (left > 0 ? ` ${left} unused cycle${left === 1 ? "" : "s"} closed with it — talk to us at the counter if that seems wrong.` : ""),
    "status",
  );
  await audit("Subscription cancelled", `${stu.name} · ${sub.plan} · ${left} cycles unused · ${note}`, st.id);
  void notifyOwner(
    "Subscription cancelled",
    `${stu.name}: "${sub.plan}" cancelled by ${st.name}. ${left} unused cycle(s) forfeited. Reason: ${note}`,
  );
  publish([`student:${studentId}`, `orders:${stu.collegeId}`], { type: "subscription", payload: { studentId } });
  return { ok: true as const, cyclesForfeited: left };
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

/* ─── Faculty cycle packs (Sep 2026) ───────────────────────────────────────

   Faculty are not sold tiered plans — they pay for however many cycles they
   want up front ("6 months × 4 a month" = 24), at the flat per-cycle rate:
   Rs 200 Wash & Fold, Rs 250 Wash & Iron. The rate is FINAL, so the payment
   is recorded (drawer, reports, Sheet all see the money) but NO GST invoice
   is minted — the owner's call, consistent with cycle pricing everywhere.

   Mechanically a pack IS a subscription with a custom bucket: planId stays
   null, the snapshot names the pack, and every existing consumer — the
   order flow, cancellation restore, the customer's balance screen — works
   unchanged. A second pack TOPS UP the first rather than replacing it:
   unused cycles are paid-for cycles, and a top-up that silently discarded
   them would be theft by bookkeeping. */
export async function sellCyclePack(
  studentId: string,
  input: { service: "washFold" | "washIron"; cycles: number; method: "cash" | "upi" },
) {
  const st = await requireStaff(2); // Manager+ — this takes money
  const rate = CYCLE_RATES[input.service];
  const cycles = Math.floor(input.cycles);
  if (!rate) return { ok: false as const, error: "Pick Wash & Fold or Wash & Iron" };
  if (!Number.isFinite(cycles) || cycles < 1 || cycles > 200) {
    return { ok: false as const, error: "Cycles must be between 1 and 200" };
  }

  const stu = await db.student.findUnique({ where: { id: studentId }, include: { subscription: true } });
  if (!stu) return { ok: false as const, error: "Student not found" };
  if (stu.kind !== "faculty") {
    return { ok: false as const, error: "Cycle packs are for faculty — students buy plans" };
  }

  const price = cycles * rate;
  const label = input.service === "washFold" ? "Wash & Fold" : "Wash & Iron";

  await db.$transaction(async (tx) => {
    type Bucket = { service: string; cycles: number; used: number; kgPerCycle: number };
    const existing = stu.subscription;
    const buckets: Bucket[] = ((existing?.buckets as unknown as Bucket[] | null) ?? []).map((b) => ({ ...b }));
    const idx = buckets.findIndex((b) => b.service === input.service);
    if (idx >= 0) buckets[idx] = { ...buckets[idx], cycles: buckets[idx].cycles + cycles };
    else buckets.push({ service: input.service, cycles, used: 0, kgPerCycle: 5 });
    const cyclesTotal = buckets.reduce((n, b) => n + b.cycles, 0);

    await tx.subscription.upsert({
      where: { studentId },
      create: {
        studentId, active: true, plan: `Cycle pack — ${label}`,
        buckets: buckets as unknown as object, cyclesTotal, kgPerCycle: 5, startedAt: new Date(),
      },
      update: {
        active: true, plan: existing?.plan?.startsWith("Cycle pack") ? existing.plan : `Cycle pack — ${label}`,
        buckets: buckets as unknown as object, cyclesTotal,
        cancelledAt: null, cancelledReason: null, cancelledBy: null,
      },
    });
    await tx.payment.create({
      data: {
        method: input.method, amount: price, collegeId: stu.collegeId, studentId,
        note: `Cycle pack: ${cycles}× ${label} @ ₹${rate}`,
      },
    });
    await enqueueSheetEvent(tx, "payment", [
      istStamp(), stu.name, `Cycle pack ${cycles}× ${label}`, price, input.method, "—",
    ]);
  });

  await audit("Cycle pack sold", `${stu.name} (${stu.id}) · ${cycles}× ${label} · ₹${price} ${input.method}`, st.id);
  await pushNotif(studentId, `${cycles} ${label} cycles added to your account — ₹${price} received. Happy washing!`, "credit");
  flushSoon();
  return { ok: true as const, price, cycles };
}
