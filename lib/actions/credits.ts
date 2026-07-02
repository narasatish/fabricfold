"use server";
/* Compensation — credits by default; cash is Manager+ only, posts a cash_out
   payment and (if the order was invoiced) raises a proportional credit note. */
import { db } from "../db";
import { requireStaff } from "../auth";
import { createCreditNote } from "../money";
import { publish } from "../realtime";
import { pushNotif, audit } from "../notify";

const KIND_LABEL: Record<string, string> = { damage: "Damage", stain: "Stain/re-do", missing: "Missing item", goodwill: "Goodwill", manual: "Adjustment" };

export async function submitCompensation(input: { studentId: string; orderId?: string | null; kind: string; amount: number; method: "credit" | "cash"; comment: string }) {
  const st = await requireStaff(input.method === "cash" ? 2 : 1); // cash comp = Manager+
  const amount = Math.floor(input.amount);
  if (!amount || amount <= 0) return { ok: false as const, error: "Enter a valid amount" };
  const stu = await db.student.findUniqueOrThrow({ where: { id: input.studentId } });

  await db.$transaction(async (tx) => {
    await tx.compensation.create({
      data: { studentId: stu.id, orderId: input.orderId || null, kind: input.kind, amount, comment: input.comment.trim() || null, by: st.id, method: input.method },
    });
    if (input.method === "credit") {
      await tx.student.update({ where: { id: stu.id }, data: { credits: { increment: amount } } });
    } else {
      await tx.payment.create({ data: { method: "cash_out", amount: -amount, collegeId: stu.collegeId, orderId: input.orderId || null, studentId: stu.id, note: "Cash compensation" } });
      if (input.orderId) {
        const inv = await tx.invoice.findUnique({ where: { orderId: input.orderId } });
        if (inv) await createCreditNote(tx, inv, amount, "Cash compensation", st.id, "cash");
      }
    }
  });

  if (input.method === "credit") await pushNotif(stu.id, `You received ₹${amount} in credits. ${input.comment || ""}`.trim(), "status");
  await audit("Compensation", `${KIND_LABEL[input.kind] || "Credit"} ₹${amount} (${input.method}) → ${stu.name}`, st.id);
  publish([`student:${stu.id}`, `orders:${stu.collegeId}`], { type: "payment", payload: { studentId: stu.id } });
  return { ok: true as const };
}
