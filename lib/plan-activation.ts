/* Core of "sell a plan to a student" — the money/subscription transaction
   shared by lib/actions/subscription.ts's assignSubscription (an existing
   student picking a plan later) and registerStudent (a St Mary's walk-in,
   where picking a plan is now MANDATORY at registration — owner, Sep 22:
   "staff need to give plan as mandatory then obviously code with B/S/G will
   be assigned... no need [of] a provisional code").

   Plain module (no "use server"), not lib/actions/subscription.ts, on
   purpose: a "use server" file may only export async server actions, so its
   helpers could not be reused from admin.ts without copy-pasting them (see
   the identical note this replaces in app/api/import/students/route.ts,
   which had its own byte-for-byte copy of usageBuckets/planGross for exactly
   this reason). One copy now, imported by every caller.

   Deliberately does NOT check requireStaff/assertSameCollege — each caller
   has its own rule for WHO may call it (assignSubscription: Manager+ on the
   student's own campus; registerStudent: Manager+ when a plan is being sold
   at registration, deliberately NOT campus-scoped — see registerStudent's
   own comment). This module only does the work once authorised. */
import { db } from "./db";

export type PlanBucket = { service: string; cycles: number; kgPerCycle: number };

export function usageBuckets(buckets: PlanBucket[]) {
  return buckets.map((b) => ({ service: b.service, cycles: b.cycles, used: 0, kgPerCycle: b.kgPerCycle }));
}

export async function planGross(plan: { price: unknown; gstFree: boolean }) {
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const gstOn = (cfg.settings as Record<string, unknown>)?.gstEnabled !== false && !plan.gstFree;
  const price = Number(plan.price);
  return price + (gstOn ? Math.round(price * Number(cfg.gstPct) / 100) : 0);
}

/* Cycle-based plans/packs are a St Mary's-style thing. BVRIT bills per piece
   and is NEVER sold a plan, for students or staff — see the belt-and-braces
   name check below, matching the identical rule in subscription.ts. */
export async function requireCyclesEnabled(collegeId: string) {
  const college = await db.college.findUniqueOrThrow({ where: { id: collegeId }, select: { name: true, features: true, rates: true } });
  if (college.name.trim().toUpperCase() === "BVRIT") {
    return "BVRIT bills per piece — cycle-based plans and packs are never sold here, for students or staff.";
  }
  if (college.rates != null) {
    return "This campus bills per piece (its own item rates are set) — cycle-based plans and packs aren't available here.";
  }
  const { featureOn } = await import("./features");
  if (!featureOn(college.features, "subscriptions")) {
    return "Cycle-based plans and packs are disabled for this campus.";
  }
  return null;
}

/**
 * Validate the plan, run the subscription+payment transaction, and enqueue
 * the Sheet events. Does NOT touch the bag/customer-ID (syncBagToPlan) or
 * send notifications/audit — callers do that themselves right after, since
 * the message wording differs (a fresh registration vs. an existing student
 * picking a plan) and a paid subscription must never roll back because a
 * follow-up step (a code, a push notification) failed — same reasoning
 * assignSubscription's own comment already gave for calling syncBagToPlan
 * outside its transaction.
 */
export async function activatePlan(
  stu: { id: string; collegeId: string; credits: unknown },
  planId: string,
  method: "cash" | "upi",
  applyCredits: boolean,
) {
  const plan = await db.plan.findUnique({ where: { id: planId } });
  if (!plan || !plan.active) return { ok: false as const, error: "Pick a plan" };
  if (plan.collegeId !== stu.collegeId) return { ok: false as const, error: "That plan belongs to a different campus" };

  const buckets = usageBuckets(plan.buckets as unknown as PlanBucket[]);
  const cyclesTotal = buckets.reduce((s, b) => s + b.cycles, 0);
  const gross = await planGross(plan);
  const creditApplied = applyCredits ? Math.min(Number(stu.credits), gross) : 0;
  const cash = gross - creditApplied;

  const { enqueuePaymentEvent } = await import("./sheet-events");

  try {
    await db.$transaction(async (tx) => {
      // Same advisory-lock-then-recheck shape as assignSubscription always
      // used — a row lock is useless for "no Subscription row exists yet".
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`subscription|${stu.id}`}))`;
      const fresh = await tx.subscription.findUnique({ where: { studentId: stu.id } });
      if (fresh?.active) throw new Error("This student already has an active plan");
      await tx.subscription.upsert({
        where: { studentId: stu.id },
        create: { studentId: stu.id, active: true, plan: plan.name, planId: plan.id, buckets, startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000), cyclesTotal, kgPerCycle: buckets[0]?.kgPerCycle ?? 7 },
        // A fresh assignment supersedes any earlier cancellation on this
        // row — left uncleared, the cancelled reason/date stuck around
        // forever and the customer page kept showing "Cancelled: ..." next
        // to an Active pill (found live, Sep 23, right after re-assigning a
        // plan that had been cancelled earlier the same day).
        update: { active: true, plan: plan.name, planId: plan.id, buckets, startedAt: new Date(), expiresAt: new Date(Date.now() + 365 * 86_400_000), cyclesTotal, cyclesUsed: 0, kgPerCycle: buckets[0]?.kgPerCycle ?? 7, cancelledAt: null, cancelledReason: null, cancelledBy: null },
      });
      if (creditApplied > 0) {
        await tx.student.update({ where: { id: stu.id }, data: { credits: { decrement: creditApplied } } });
        await tx.payment.create({ data: { method: "credit", amount: creditApplied, collegeId: stu.collegeId, studentId: stu.id, note: `Subscription: ${plan.name} (credit applied)` } });
        await enqueuePaymentEvent(tx, { collegeId: stu.collegeId, studentId: stu.id, label: `Plan: ${plan.name}`, method: "credit", amount: creditApplied });
      }
      if (cash > 0) {
        await tx.payment.create({ data: { method, amount: cash, collegeId: stu.collegeId, studentId: stu.id, note: `Subscription: ${plan.name} (assigned at counter)` } });
        await enqueuePaymentEvent(tx, { collegeId: stu.collegeId, studentId: stu.id, label: `Plan: ${plan.name}`, method, amount: cash });
      }
    }, { timeout: 15_000 });
  } catch (e) {
    return { ok: false as const, error: (e as Error).message };
  }
  const paidNote = creditApplied > 0 ? (cash > 0 ? `₹${cash} ${method.toUpperCase()} + ₹${creditApplied} credit` : `₹${creditApplied} credit`) : `₹${gross} (${method.toUpperCase()})`;
  return { ok: true as const, plan, gross, cash, creditApplied, paidNote };
}
