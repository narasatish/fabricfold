"use server";
/* Complaints + chat threads (realtime both sides). */
import { db } from "../db";
import { requireStudent, requireStaff, getSession } from "../auth";
import { publish } from "../realtime";
import { pushNotif } from "../notify";

export async function submitComplaint(text: string, orderId?: string | null) {
  const stu = await requireStudent();
  const t = text.trim();
  if (!t) return { ok: false as const, error: "Please describe the issue" };
  const c = await db.complaint.create({
    data: {
      studentId: stu.id, collegeId: stu.collegeId, text: t, orderId: orderId || null,
      messages: { create: { from: "student", by: stu.id, text: t } },
    },
  });
  publish([`orders:${stu.collegeId}`], { type: "complaint.message", payload: { complaintId: c.id } });
  return { ok: true as const, id: c.id };
}

export async function sendComplaintMessage(complaintId: string, text: string) {
  const t = text.trim();
  if (!t) return { ok: false as const, error: "Type a message" };
  const s = await getSession();
  const c = await db.complaint.findUniqueOrThrow({ where: { id: complaintId } });
  if (c.status !== "open") return { ok: false as const, error: "Complaint is closed" };

  if (s?.mode === "customer") {
    const stu = await requireStudent();
    if (c.studentId !== stu.id) return { ok: false as const, error: "Not your complaint" };
    await db.complaintMessage.create({ data: { complaintId, from: "student", by: stu.id, text: t } });
    publish([`orders:${c.collegeId}`], { type: "complaint.message", payload: { complaintId } });
  } else {
    const st = await requireStaff(1);
    await db.complaintMessage.create({ data: { complaintId, from: "staff", by: st.id, text: t } });
    await pushNotif(c.studentId, `Staff replied to your complaint: "${t.slice(0, 80)}"`, "status");
    publish([`student:${c.studentId}`], { type: "complaint.message", payload: { complaintId } });
  }
  return { ok: true as const };
}

export async function resolveComplaint(complaintId: string, resolution: string): Promise<{ ok: boolean; error?: string }> {
  const st = await requireStaff(1);
  const c = await db.complaint.findUniqueOrThrow({ where: { id: complaintId } });
  const res = resolution.trim() || "Resolved by staff.";
  await db.complaint.update({ where: { id: complaintId }, data: { status: "resolved", resolvedAt: new Date() } });
  await db.complaintMessage.create({ data: { complaintId, from: "staff", by: st.id, text: "Resolved: " + res } });
  await pushNotif(c.studentId, "Your complaint was resolved: " + res, "status");
  publish([`student:${c.studentId}`, `orders:${c.collegeId}`], { type: "complaint.message", payload: { complaintId } });
  return { ok: true as const };
}
