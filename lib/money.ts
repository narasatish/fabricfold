/* Money & GST rules — ported EXACTLY from the prototype (see handoff README).
   - Prices are GST-INCLUSIVE; `gst` is the tax component of total.
   - UPI payments auto-create a GST tax invoice; cash only via staff override;
     credit-only never invoiced.
   - Invoice/credit-note numbers are per Indian financial year (April start),
     backed by a transactional sequence (no gaps/duplicates). */
import { db } from "./db";
import type { Prisma } from "./generated/prisma/client";

/* Same-day express surcharge = 40% of the order value (subtotal). Flat rule for
   every college — not configurable per campus. */
export const EXPRESS_PCT = 0.4;
export function expressSurcharge(subtotal: number) {
  return Math.round(subtotal * EXPRESS_PCT);
}

/* Urgent (same-day) surcharge for an order paid with a subscription cycle.
   The cycle itself is already prepaid — one of the plan's total cycles — so
   consuming it costs nothing extra. Urgent is an add-on service on top of
   that, priced at the same 40% as a normal express order, but since a cycle
   order has no per-item "order value" to take 40% of, the base is the plan's
   own average value per cycle (planPrice ÷ totalCycles). Charged in cash. */
export function urgentCycleCharge(planPrice: number, cyclesTotal: number) {
  if (!cyclesTotal) return 0;
  const perCycle = planPrice / cyclesTotal;
  return Math.round(perCycle * EXPRESS_PCT);
}

export function financialYearTag(ts?: number | Date) {
  const dt = ts ? new Date(ts) : new Date();
  const y = dt.getFullYear();
  const start = dt.getMonth() >= 3 ? y : y - 1;
  return String(start).slice(-2) + String((start + 1) % 100).padStart(2, "0");
}

type Tx = Prisma.TransactionClient;

async function nextSeq(tx: Tx, kind: "invoice" | "credit_note", fyTag: string) {
  const row = await tx.fySequence.upsert({
    where: { kind_fyTag: { kind, fyTag } },
    create: { kind, fyTag, value: 1 },
    update: { value: { increment: 1 } },
  });
  return row.value;
}

export async function nextInvoiceNo(tx: Tx) {
  const fy = financialYearTag();
  const n = await nextSeq(tx, "invoice", fy);
  return `INV-${fy}-${String(n).padStart(4, "0")}`;
}

export async function nextCreditNoteNo(tx: Tx) {
  const fy = financialYearTag();
  const n = await nextSeq(tx, "credit_note", fy);
  return `CN-${fy}-${String(n).padStart(4, "0")}`;
}

/** Should this payment method produce a GST tax invoice?
    UPI (incl. split "upi+credit") => yes. Cash => only with staff override. Credit-only => never. */
export function shouldInvoice(method: string, staffInvoiceOverride = false) {
  if (method.includes("upi")) return true;
  if (method.includes("cash") && staffInvoiceOverride) return true;
  return false;
}

/** Order-aware invoice rule: a no-GST order is never invoiced, whatever the method. */
export function shouldInvoiceOrder(o: { noGst?: boolean }, method: string, staffInvoiceOverride = false) {
  if (o.noGst) return false;
  return shouldInvoice(method, staffInvoiceOverride);
}

/* ─── Cycle weight allowance ───────────────────────────────────────────────

   Every plan includes the SAME 7 kg per cycle, whatever the tier. The tiers
   differ in how many cycles you get, not how heavy each one may be — so this
   is a constant, not a per-plan field.

   It deliberately ignores Subscription.kgPerCycle and the per-bucket
   kgPerCycle still stored on existing rows. Reading those meant two students
   on the same plan could get different allowances depending on when they
   subscribed, and nothing stopped a stray value being saved. 7 matches what
   current plans were sold with, so existing subscribers keep exactly the deal
   they bought. The columns stay (old orders were billed against them and the
   history must still read correctly); they are simply no longer consulted
   when billing a new order. */
export const CYCLE_KG_LIMIT = 5;

/* Flat rupees per kg over the allowance, charged in HALF-kg steps. Owner-set
   (Sep 2026, refined): 6.5 kg = 1.5 kg over = Rs 50 + Rs 25 = Rs 75. Half-kg
   granularity is the owner's own worked example — whole-kg rounding would
   charge Rs 100 for the same bag, and Rs 25 steps are still sayable at the
   counter. The 500-600 g grace the owner allows is not a rule here: it is
   staff judgement, which is exactly what the waive toggle records. */
export const EXCESS_PER_KG = 50;
export const EXCESS_PER_HALF_KG = 25;

/* ─── Cycle-basis billing (owner, Sep 2026) ────────────────────────────────

   Wash services are sold by the CYCLE, not the garment: Rs 200 per Wash &
   Fold cycle, Rs 250 per Wash & Iron, each cycle carrying the 5 kg
   allowance. The rate is FINAL — what the student hands over — so cycle
   orders are always billed without GST. Dry cleaning (and Iron Only) stay
   per-piece; a saree and a blanket are not a weight class. */
export const CYCLE_RATES: Record<string, number> = { washFold: 200, washIron: 250 };
export function isCycleService(service: string) {
  return service in CYCLE_RATES;
}

/**
 * What the student owes for weight beyond the cycle's 5 kg.
 *
 * PROPORTIONAL, not rounded up to the next whole kilo. The old code did
 * `Math.ceil(over)`, so a bag 200 g over the limit was billed a full extra
 * Rounded UP to the started HALF kilogram: 5.2 kg bills as 0.5 over (Rs 25),
 * 6.5 kg as 1.5 over (Rs 75) — the owner's own example. A scale reading 5.2
 * on one weighing and 5.4 on the next gives the same price.
 *
 * `cycles` is how many cycles this order uses — a student may burn two at
 * once for a 9 kg bag, and the allowance scales with them: 2 cycles = 10 kg
 * free before the excess starts.
 *
 * `waived` zeroes the charge — staff judgement (the ~half-kg grace the owner
 * allows, a bedsheet week, a scale acting up). Audited with who did it.
 */
export function excessWeightCharge(
  weightKg: number | null | undefined,
  _basePieceRate?: number,
  opts: { waived?: boolean; cycles?: number } = {},
) {
  if (opts.waived) return 0;
  const cycles = Math.max(1, Math.floor(opts.cycles ?? 1));
  const over = (Number(weightKg) || 0) - CYCLE_KG_LIMIT * cycles;
  if (over <= 0) return 0;
  return Math.ceil(over * 2) * EXCESS_PER_HALF_KG;
}

/** Bill math shared by acceptOrder and tests. Cycle orders carry only the excess charge. */
export function computeBill(sub: number, surcharge: number, gstPct: number, opts: { usedCycle?: boolean; excessCharge?: number; noGst?: boolean } = {}) {
  // A cycle order carries no GST (the plan was already billed/invoiced when
  // it was bought), but `surcharge` still has to be collected in cash where
  // it's non-zero — e.g. the urgent-cycle premium above. Previously this
  // branch silently dropped `surcharge`, so marking a cycle order express
  // charged nothing at all.
  if (opts.usedCycle) return { gst: 0, total: (opts.excessCharge || 0) + surcharge };
  const taxable = sub + surcharge;
  const gst = opts.noGst ? 0 : Math.round(taxable * (gstPct / 100));
  /* excessCharge also reaches this branch now: a NON-subscriber paying
     Rs 200 for a 6 kg cycle owes 200 + 50, and the excess sits outside the
     taxable base — it is the same flat per-kg charge a plan holder pays,
     never a priced garment. Zero for every per-piece service. */
  return { gst, total: taxable + gst + (opts.excessCharge || 0) };
}

/** Create the GST tax invoice for an order (inside the payment transaction). */
export async function createInvoice(
  tx: Tx,
  o: { id: string; studentId: string; collegeId: string; subtotal: unknown; surcharge: unknown; gst: unknown; gstPctSnapshot: unknown; total: unknown },
  method: string,
) {
  const number = await nextInvoiceNo(tx);
  return tx.invoice.create({
    data: {
      number,
      orderId: o.id,
      studentId: o.studentId,
      collegeId: o.collegeId,
      subtotal: Number(o.subtotal) + Number(o.surcharge || 0),
      gst: Number(o.gst),
      gstPct: Number(o.gstPctSnapshot),
      total: Number(o.total),
      method,
    },
  });
}

/** Raise a PROPORTIONAL GST credit note against an invoiced order (refund / cash comp). */
export async function createCreditNote(
  tx: Tx,
  invoice: { id: string; orderId: string; studentId: string; collegeId: string; subtotal: unknown; gst: unknown; total: unknown },
  amount: number,
  reason: string,
  by: string,
  via: string,
) {
  const ratio = Math.min(1, amount / Number(invoice.total));
  const gst = Math.round(Number(invoice.gst) * ratio * 100) / 100;
  const subtotal = Math.round((amount - gst) * 100) / 100;
  const number = await nextCreditNoteNo(tx);
  return tx.creditNote.create({
    data: {
      number,
      invoiceId: invoice.id,
      orderId: invoice.orderId,
      studentId: invoice.studentId,
      collegeId: invoice.collegeId,
      subtotal,
      gst,
      total: amount,
      reason,
      by,
      via,
    },
  });
}

/** SLA: due = received + (express ? 1 : 2) days. */
export function orderDueAt(o: { receivedAt: Date | null; express: boolean }) {
  if (!o.receivedAt) return null;
  return new Date(o.receivedAt.getTime() + (o.express ? 1 : 2) * 86_400_000);
}
export function isOverdue(o: { status: string; receivedAt: Date | null; express: boolean }) {
  if (o.status !== "received" && o.status !== "processing") return false;
  const due = orderDueAt(o);
  return !!due && due.getTime() < Date.now();
}

/** Loyalty: Bronze <50, Silver 50–149, Gold 150+ (cosmetic). */
export function loyaltyTier(lifetimePieces: number) {
  return lifetimePieces >= 150 ? "Gold" : lifetimePieces >= 50 ? "Silver" : "Bronze";
}
