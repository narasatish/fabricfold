"use server";
/* Per-college subscription plans.
   Colleges define their own plans (Admin), each bundling one or more service
   "buckets" (e.g. 20 Wash&Fold + 14 Wash&Iron). Students see and request only
   their college's plans; Manager+ activates (cash OTP / UPI) or assigns
   directly. Cycle consumption per-bucket happens in acceptOrder. */
import { db, dbSchemaPrefix } from "../db";
import { Prisma } from "../generated/prisma/client";
import { requireStudent, requireStaff, assertSameCollege } from "../auth";
import { publish } from "../realtime";
import { pushNotif, audit } from "../notify";
import { notifyOwner } from "../mail";
import { syncBagToPlan } from "./bags";
import { CYCLE_RATES } from "../money";
import { featureOn } from "../features";
import { enqueueSheetEvent, flushSoon, istStamp } from "../sheet-events";
import { rosterSoon } from "../sheets-sync";

const rid = (n: number) => { let s = ""; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; };

/* lib/money.ts's collegeUsesCycleBasedPricing already encodes the rule: a
   college with its own item-rates override (College.rates non-null, e.g.
   BVRIT) bills every garment per piece and is NEVER cycle-based — that rule
   is enforced for individual orders (the cycle stepper is hidden, see
   cycle-model.test.ts's "walk-in: cycle stepper" case) but was never applied
   to the BULK actions that sell cycles in advance: assignSubscription,
   upgradeSubscription, activateSubscription, and sellCyclePack all ran
   unconditionally regardless of the college's rates override, so a per-piece
   campus like BVRIT could still have a 34-cycle Wash & Fold plan or a raw
   cycle pack sold to a student — money paid for something that per-order
   pricing would then never actually consume by the cycle. Also gated on the
   admin-facing "subscriptions" feature flag (features.ts / AdminClient.tsx),
   which existed in the toggle UI but, like the rates-override case, nothing
   server-side ever actually read. */
async function requireCyclesEnabled(collegeId: string) {
  const college = await db.college.findUniqueOrThrow({ where: { id: collegeId }, select: { name: true, features: true, rates: true } });
  /* Owner's explicit, repeated instruction (Sep 2026): BVRIT is never sold
     cycles — plans or packs — for students OR staff, full stop. The
     rates-override check below is the general rule for any per-piece
     campus, and should already cover BVRIT once its `rates` column is set
     in the live database — but this session has no way to directly confirm
     that column's live production value (no Render DB credentials
     available here; the local .env points at the old Sydney/dev Supabase
     project, not production — see docs/claude-playbook.md's "Infrastructure
     reality" section on why that distinction matters). Matching on name is
     a deliberate belt-and-suspenders backstop so the rule holds even if
     BVRIT's `rates`/`features.subscriptions` ever end up unset or wrong in
     production — it does not replace the general check below, which still
     protects every OTHER per-piece campus. */
  if (college.name.trim().toUpperCase() === "BVRIT") {
    return "BVRIT bills per piece — cycle-based plans and packs are never sold here, for students or staff.";
  }
  if (college.rates != null) {
    return "This campus bills per piece (its own item rates are set) — cycle-based plans and packs aren't available here.";
  }
  if (!featureOn(college.features, "subscriptions")) {
    return "Cycle-based plans and packs are disabled for this campus.";
  }
  return null;
}

type PlanBucket = { service: string; cycles: number; kgPerCycle: number };

/**
 * Manually correct how many cycles a student has used, per service bucket —
 * e.g. fixing a wrong count after a bulk import, or a counter mistake never
 * caught at the time. Admin+ only: this directly changes what a student is
 * entitled to use next, the same trust level as changing their campus.
 *
 * `used` per service is clamped to that bucket's own `cycles` ceiling — never
 * negative, never more than the bucket actually holds. cyclesUsed (the
 * aggregate used elsewhere for "cycles left") is recomputed as the sum, so it
 * can never drift from the buckets it's supposed to summarize.
 */
export async function adjustCycleUsage(studentId: string, updates: { service: string; used: number }[]) {
  const st = await requireStaff(3);
  const stu = await db.student.findUnique({ where: { id: studentId }, include: { subscription: true } });
  if (!stu) return { ok: false as const, error: "Student not found" };
  assertSameCollege(st, stu.collegeId);
  if (!stu.subscription) return { ok: false as const, error: "This student has no plan" };

  type Bucket = { service: string; cycles: number; used: number; kgPerCycle: number };
  const byService = new Map(updates.map((u) => [u.service, u.used]));
  const changes: string[] = [];

  // Locked, then re-read fresh — same hazard as every other writer of
  // Subscription.buckets (sellCyclePack/assignSubscription/upgradeSubscription):
  // a cycle consumed by an in-flight order between the read above and this
  // write would otherwise be silently overwritten by this stale snapshot.
  const changed = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM ${Prisma.raw(`${dbSchemaPrefix}"Subscription"`)} WHERE "studentId" = ${studentId} FOR UPDATE`;
    const fresh = await tx.subscription.findUniqueOrThrow({ where: { studentId } });
    const buckets = (fresh.buckets as unknown as Bucket[] | null) ?? [];
    const newBuckets = buckets.map((b) => {
      if (!byService.has(b.service)) return b;
      const requested = byService.get(b.service)!;
      const clamped = Math.max(0, Math.min(b.cycles, Math.floor(requested)));
      if (clamped !== b.used) changes.push(`${b.service} ${b.used} → ${clamped}`);
      return { ...b, used: clamped };
    });
    if (!changes.length) return false;
    const cyclesUsed = newBuckets.reduce((s, b) => s + b.used, 0);
    await tx.subscription.update({ where: { studentId }, data: { buckets: newBuckets, cyclesUsed } });
    return true;
  });
  if (!changed) return { ok: true as const, changed: false };
  await audit("Cycle usage corrected", `${stu.name} (${stu.id}) · ${changes.join("; ")}`, st.id);
  rosterSoon();
  publish([`student:${studentId}`], { type: "subscription", payload: { studentId } });
  return { ok: true as const, changed: true, changes };
}

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
  assertSameCollege(st, stu.collegeId);
  const gateErr = await requireCyclesEnabled(stu.collegeId);
  if (gateErr) return { ok: false as const, error: gateErr };
  if (!stu.subscription) return { ok: false as const, error: "No pending subscription request" };

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
  rosterSoon();
  void notifyOwner("Subscription activated", `${stu.name}: "${stu.subscription.plan}" — ₹${gross} received by ${method.toUpperCase()} (activated by ${st.name}).`);
  publish([`student:${studentId}`, `orders:${stu.collegeId}`], { type: "subscription", payload: { studentId } });
  return { ok: true as const, code: bag.ok ? bag.code : undefined, bagError: bag.ok ? undefined : bag.error };
}

/** Manager+ assigns a plan DIRECTLY (no request/OTP; payment taken at counter).
    `applyCredits` lets a student's compensation credits cover part or all of
    the price — same idea as an order's "Apply credits" toggle (payCore in
    orders.ts), just without an Order to hang a CreditUse row off, so the
    credit spend is recorded as its own Payment row (method "credit") instead. */
export async function assignSubscription(studentId: string, planId: string, method: "cash" | "upi", applyCredits = false) {
  const st = await requireStaff(2); // Manager+ only
  const stu = await db.student.findUnique({ where: { id: studentId }, include: { subscription: true } });
  if (!stu) return { ok: false as const, error: "Student not found" };
  assertSameCollege(st, stu.collegeId);
  const gateErr = await requireCyclesEnabled(stu.collegeId);
  if (gateErr) return { ok: false as const, error: gateErr };
  if (stu.subscription?.active) return { ok: false as const, error: "This student already has an active plan" };

  const plan = await db.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.active) return { ok: false as const, error: "Pick a plan" };
  if (plan.collegeId !== stu.collegeId) return { ok: false as const, error: "That plan belongs to a different campus" };

  const buckets = usageBuckets(plan.buckets as unknown as PlanBucket[]);
  const cyclesTotal = buckets.reduce((s, b) => s + b.cycles, 0);
  const gross = await planGross(plan);
  const creditApplied = applyCredits ? Math.min(Number(stu.credits), gross) : 0;
  const cash = gross - creditApplied;

  try {
    await db.$transaction(async (tx) => {
      /* Locked, then re-checked — the `stu.subscription?.active` guard above
         ran before this transaction started, so two concurrent assigns for a
         student with no plan yet would both pass it and both charge a
         Payment row for the same plan. */
      await tx.$executeRaw`SELECT id FROM ${Prisma.raw(`${dbSchemaPrefix}"Subscription"`)} WHERE "studentId" = ${studentId} FOR UPDATE`;
      const fresh = await tx.subscription.findUnique({ where: { studentId } });
      if (fresh?.active) throw new Error("This student already has an active plan");
      await tx.subscription.upsert({
        where: { studentId },
        create: { studentId, active: true, plan: plan.name, planId: plan.id, buckets, startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000), cyclesTotal, kgPerCycle: buckets[0]?.kgPerCycle ?? 7 },
        update: { active: true, plan: plan.name, planId: plan.id, buckets, startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000), cyclesTotal, cyclesUsed: 0, kgPerCycle: buckets[0]?.kgPerCycle ?? 7 },
      });
      if (creditApplied > 0) {
        await tx.student.update({ where: { id: studentId }, data: { credits: { decrement: creditApplied } } });
        await tx.payment.create({ data: { method: "credit", amount: creditApplied, collegeId: stu.collegeId, studentId, note: `Subscription: ${plan.name} (credit applied)` } });
      }
      if (cash > 0) {
        await tx.payment.create({ data: { method, amount: cash, collegeId: stu.collegeId, studentId, note: `Subscription: ${plan.name} (assigned at counter)` } });
      }
    });
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
  await db.otp.deleteMany({ where: { purpose: "subscription", refId: studentId } });

  /* The customer ID follows the plan. Bronze -> B###, Silver -> S###, Gold ->
     G###. Doing it here is the whole point: assigning a plan and issuing the
     bag used to be two unconnected steps, so a Silver subscriber could sit
     with no S-code at all until someone remembered the second one.

     Deliberately AFTER the payment transaction and not inside it — a paid
     subscription must not roll back because a code could not be allocated.
     A failure is reported to the caller, not thrown. */
  const bag = await syncBagToPlan(studentId);

  const paidNote = creditApplied > 0 ? (cash > 0 ? `₹${cash} ${method.toUpperCase()} + ₹${creditApplied} credit` : `₹${creditApplied} credit`) : `₹${gross} (${method.toUpperCase()})`;
  await pushNotif(studentId, `Your "${plan.name}" plan is active. Happy washing!`, "status");
  await audit("Subscription assigned", `${stu.name} · ${plan.name} · ${paidNote}${bag.ok && bag.code ? ` · ${bag.code}` : ""}`, st.id);
  rosterSoon();
  void notifyOwner("Subscription assigned", `${stu.name}: "${plan.name}" — ${paidNote} (assigned by ${st.name}).`);
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
  assertSameCollege(st, stu.collegeId);
  const gateErr = await requireCyclesEnabled(stu.collegeId);
  if (gateErr) return { ok: false as const, error: gateErr };
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

  type Used = { service: string; cycles: number; used: number; kgPerCycle: number };
  let cyclesTotal = 0, cyclesUsed = 0, kgPerCycle = Number(cur.kgPerCycle);

  await db.$transaction(async (tx) => {
    /* Locked, then re-read fresh — not the `cur` fetched before this
       transaction started. A cycle burned by an in-flight order between
       that read and this write (accept/walk-in run their own transaction
       and could commit in the gap) would otherwise get silently overwritten
       by this update's stale usedByService snapshot, understating what the
       student has actually used. */
    await tx.$executeRaw`SELECT id FROM ${Prisma.raw(`${dbSchemaPrefix}"Subscription"`)} WHERE "studentId" = ${studentId} FOR UPDATE`;
    const fresh = await tx.subscription.findUniqueOrThrow({ where: { studentId } });

    // Rebuild buckets on the new plan, carrying the old usage across.
    const oldBuckets = (fresh.buckets as unknown as Used[] | null) || [];
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
    if (!oldBuckets.length && fresh.cyclesUsed > 0) {
      let toSpend = fresh.cyclesUsed;
      buckets = buckets.map((b) => {
        const take = Math.min(b.cycles, toSpend);
        toSpend -= take;
        return { ...b, used: take };
      });
    }

    cyclesTotal = buckets.reduce((s, b) => s + b.cycles, 0);
    cyclesUsed = buckets.reduce((s, b) => s + b.used, 0);
    kgPerCycle = buckets[0]?.kgPerCycle ?? Number(fresh.kgPerCycle);

    await tx.subscription.update({
      where: { studentId },
      data: { plan: plan.name, planId: plan.id, buckets, cyclesTotal, cyclesUsed, kgPerCycle },
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
  rosterSoon();
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
  assertSameCollege(st, stu.collegeId);
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
  rosterSoon();
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
  input: { service: "washFold" | "washIron"; cycles: number; method: "cash" | "upi"; applyCredits?: boolean },
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
  assertSameCollege(st, stu.collegeId);
  const gateErr = await requireCyclesEnabled(stu.collegeId);
  if (gateErr) return { ok: false as const, error: gateErr };

  const price = cycles * rate;
  const label = input.service === "washFold" ? "Wash & Fold" : "Wash & Iron";
  const creditApplied = input.applyCredits ? Math.min(Number(stu.credits), price) : 0;
  const cash = price - creditApplied;

  await db.$transaction(async (tx) => {
    type Bucket = { service: string; cycles: number; used: number; kgPerCycle: number };
    /* SELECT ... FOR UPDATE, not a plain read — Postgres's default READ
       COMMITTED lets two concurrent transactions both read the same "before"
       state before either writes, so reading inside the transaction alone
       does NOT stop the race: two concurrent top-ups (two terminals, or a
       retried request) would still both compute from the same snapshot, and
       the second write overwrites the first's bucket array instead of
       adding to it — the student pays twice but only one top-up's cycles
       land. The row lock forces the second transaction to wait for the
       first to commit, then see its result. A row that doesn't exist yet
       (first-ever pack for this student) has nothing to lock — fine, since
       there's nothing to race against either. */
    await tx.$executeRaw`SELECT id FROM ${Prisma.raw(`${dbSchemaPrefix}"Subscription"`)} WHERE "studentId" = ${studentId} FOR UPDATE`;
    const existing = await tx.subscription.findUnique({ where: { studentId } });
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
    if (creditApplied > 0) {
      await tx.student.update({ where: { id: studentId }, data: { credits: { decrement: creditApplied } } });
      await tx.payment.create({ data: { method: "credit", amount: creditApplied, collegeId: stu.collegeId, studentId, note: `Cycle pack: ${cycles}× ${label} (credit applied)` } });
    }
    if (cash > 0) {
      await tx.payment.create({
        data: {
          method: input.method, amount: cash, collegeId: stu.collegeId, studentId,
          note: `Cycle pack: ${cycles}× ${label} @ ₹${rate}`,
        },
      });
    }
    await enqueueSheetEvent(tx, "payment", [
      istStamp(), stu.name, `Cycle pack ${cycles}× ${label}`, price, creditApplied > 0 ? (cash > 0 ? `${input.method}+credit` : "credit") : input.method, "—",
    ]);
  });

  const paidNote = creditApplied > 0 ? (cash > 0 ? `₹${cash} ${input.method} + ₹${creditApplied} credit` : `₹${creditApplied} credit`) : `₹${price} ${input.method}`;
  await audit("Cycle pack sold", `${stu.name} (${stu.id}) · ${cycles}× ${label} · ${paidNote}`, st.id);
  rosterSoon();
  await pushNotif(studentId, `${cycles} ${label} cycles added to your account — ${paidNote}. Happy washing!`, "credit");
  flushSoon();
  return { ok: true as const, price, cycles };
}
