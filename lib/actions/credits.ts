"use server";
/* Compensation — credits by default; cash is Manager+ only, posts a cash_out
   payment and (if the order was invoiced) raises a proportional credit note. */
import { enqueuePaymentEvent, flushSoon } from "../sheet-events";
import { db } from "../db";
import { requireStaffPerm, assertSameCollege } from "../auth";
import { createCreditNote } from "../money";
import { publish } from "../realtime";
import { pushNotif, audit } from "../notify";

const KIND_LABEL: Record<string, string> = { damage: "Damage", stain: "Stain/re-do", missing: "Missing item", goodwill: "Goodwill", manual: "Adjustment" };

export async function submitCompensation(input: { studentId: string; orderId?: string | null; complaintId?: string | null; kind: string; amount: number; method: "credit" | "cash"; comment: string }) {
  if (String(input.comment ?? "").length > 300) return { ok: false as const, error: "Keep the comment under 300 characters" };
  /* Compensation gives money away, so it rides the refunds tool. The old
     "credit comp = any staff" quietly meant Counter could mint wallet money;
     grantable now, but a deliberate grant rather than a default. Cash still
     additionally needs Manager+ — notes leave a drawer, not a database. */
  const st = await requireStaffPerm("refunds");
  if (input.method === "cash" && st.role < 2) return { ok: false as const, error: "Cash compensation needs a Manager" };
  const amount = Math.floor(input.amount);
  // Matches topUpCredits' guard (lib/actions/ops.ts) — without the upper
  // bound, `amount: Infinity` sailed through `!amount || amount <= 0`
  // (Infinity is truthy and not <= 0) and reached
  // `credits: { increment: Infinity }`, permanently corrupting the wallet.
  if (!amount || amount <= 0 || amount > 50_000) return { ok: false as const, error: "Enter a valid amount" };
  const stu = await db.student.findUniqueOrThrow({ where: { id: input.studentId } });
  assertSameCollege(st, stu.collegeId);

  try {
    await db.$transaction(async (tx) => {
      // A double-tap on the compensation button could fire two submissions
      // concurrently. Check within the transaction if the exact same
      // compensation was already issued (same orderId/complaintId/kind), and
      // bail if so — the second tap gets a friendly error instead of creating
      // a duplicate payout.
      const existing = await tx.compensation.findFirst({
        where: {
          studentId: stu.id,
          orderId: input.orderId || null,
          complaintId: input.complaintId || null,
          kind: input.kind,
        },
      });
      if (existing) throw new Error("This compensation was already issued");

      await tx.compensation.create({
        // complaintId ties a payout to the grievance that justified it, so the
        // cost of a service failure is traceable rather than a loose adjustment.
        data: { studentId: stu.id, orderId: input.orderId || null, complaintId: input.complaintId || null, kind: input.kind, amount, comment: input.comment.trim() || null, by: st.id, method: input.method },
      });
      if (input.method === "credit") {
        await tx.student.update({ where: { id: stu.id }, data: { credits: { increment: amount } } });
      } else {
        await tx.payment.create({ data: { method: "cash_out", amount: -amount, collegeId: stu.collegeId, orderId: input.orderId || null, studentId: stu.id, note: "Cash compensation" } });
        await enqueuePaymentEvent(tx, { collegeId: stu.collegeId, studentId: stu.id, label: input.orderId ? "Compensation #" + input.orderId.slice(-6) : "Compensation", method: "cash payout", amount: -amount });
        if (input.orderId) {
          const inv = await tx.invoice.findUnique({ where: { orderId: input.orderId } });
          if (inv) await createCreditNote(tx, inv, amount, "Cash compensation", st.id, "cash");
        }
      }
    });
  } catch (e) {
    // Backstop for the findFirst-inside-the-transaction check above: that read
    // can lose a genuine concurrent-double-tap race under Read Committed
    // isolation, but the DB-level compensation_dupe_uniq index (ensure-guards.mjs)
    // cannot, and reports the same collision here as a P2002.
    if ((e as { code?: string }).code === "P2002") {
      return { ok: false as const, error: "This compensation was already issued" };
    }
    return { ok: false as const, error: (e as Error).message };
  }

  flushSoon();
  if (input.method === "credit") await pushNotif(stu.id, `You received ₹${amount} in credits. ${input.comment || ""}`.trim(), "status");
  await audit("Compensation", `${KIND_LABEL[input.kind] || "Credit"} ₹${amount} (${input.method}) → ${stu.name}`, st.id);
  publish([`student:${stu.id}`, `orders:${stu.collegeId}`], { type: "payment", payload: { studentId: stu.id } });
  return { ok: true as const };
}
