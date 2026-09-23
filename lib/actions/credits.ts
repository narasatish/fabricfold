"use server";
/* Compensation — store credit only (owner, Sep 23: "compensation should be
   used as credits thats all"). Cash compensation is retired: it used to post
   a cash_out payment straight out of the drawer with only a Manager check
   between a staff member and real money leaving the till. Credit is a
   database entry an Admin/Owner can see and reverse; it can't walk out the
   door. */
import { flushSoon } from "../sheet-events";
import { db } from "../db";
import { requireStaffPerm, assertSameCollege } from "../auth";
import { publish } from "../realtime";
import { pushNotif, audit } from "../notify";

const KIND_LABEL: Record<string, string> = { damage: "Damage", stain: "Stain/re-do", missing: "Missing item", goodwill: "Goodwill", manual: "Adjustment" };

// Owner, Sep 23: staff can grant up to ₹2,000 on their own; anything above
// that needs an Admin (role 3) or the Owner (role 4) to actually submit it.
const STAFF_COMP_CAP = 2000;

export async function submitCompensation(input: { studentId: string; orderId?: string | null; complaintId?: string | null; kind: string; amount: number; comment: string }) {
  if (String(input.comment ?? "").length > 300) return { ok: false as const, error: "Keep the comment under 300 characters" };
  // Compensation gives money away, so it rides the refunds tool.
  const st = await requireStaffPerm("refunds");
  const amount = Math.floor(input.amount);
  // Matches topUpCredits' guard (lib/actions/ops.ts) — without the upper
  // bound, `amount: Infinity` sailed through `!amount || amount <= 0`
  // (Infinity is truthy and not <= 0) and reached
  // `credits: { increment: Infinity }`, permanently corrupting the wallet.
  if (!amount || amount <= 0 || amount > 50_000) return { ok: false as const, error: "Enter a valid amount" };
  if (amount > STAFF_COMP_CAP && st.role < 3) {
    return { ok: false as const, error: `Compensation over ₹${STAFF_COMP_CAP} needs Admin approval` };
  }
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
        // method is always "credit" now — the column stays (old cash rows
        // still need to read back correctly) but every new grant is credit.
        data: { studentId: stu.id, orderId: input.orderId || null, complaintId: input.complaintId || null, kind: input.kind, amount, comment: input.comment.trim() || null, by: st.id, method: "credit" },
      });
      await tx.student.update({ where: { id: stu.id }, data: { credits: { increment: amount } } });
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
  await pushNotif(stu.id, `You received ₹${amount} in credits. ${input.comment || ""}`.trim(), "status");
  await audit("Compensation", `${KIND_LABEL[input.kind] || "Credit"} ₹${amount} (credit) → ${stu.name}`, st.id);
  publish([`student:${stu.id}`, `orders:${stu.collegeId}`], { type: "payment", payload: { studentId: stu.id } });
  return { ok: true as const };
}
