"use server";
/* Complaints + chat threads (realtime both sides). */
import { db } from "../db";
import { requireStudent, requireStaff, getSession, assertSameCollege } from "../auth";
import { publish } from "../realtime";
import { pushNotif, audit, sendWhatsAppPhotos } from "../notify";
import { notifyOwner } from "../mail";
import { redoOrder } from "./orders";
// Constants/helpers live outside this module: a "use server" file may only
// export async functions, and a stray `export const` here silently wipes out
// every other export in the file.
import { MIN_DAMAGE_PHOTOS, cleanPhotos } from "../complaint-rules";
import { enqueueSheetEvent, customerIdFor, istStamp, flushSoon } from "../sheet-events";

export async function submitComplaint(text: string, orderId?: string | null, photos?: string[]) {
  const stu = await requireStudent();
  const t = text.trim();
  if (!t) return { ok: false as const, error: "Please describe the issue" };

  /* Students attach the same evidence staff do: at least MIN_DAMAGE_PHOTOS.
     A complaint is the opening of a dispute about someone's clothes, and it
     has to stand on its own weeks later — "there was a stain" proves nothing
     once the garment has been washed again, whichever side is right.

     Enforced here as well as in the UI. The client disables the button, but a
     server action is a public endpoint: the check that counts is this one. */
  const pics = cleanPhotos(photos);
  if (pics.length < MIN_DAMAGE_PHOTOS) {
    return {
      ok: false as const,
      error: `Please attach at least ${MIN_DAMAGE_PHOTOS} photos of the problem (${pics.length} so far) — they are what settles the claim.`,
    };
  }
  const c = await db.complaint.create({
    data: {
      studentId: stu.id, collegeId: stu.collegeId, text: t, orderId: orderId || null,
      messages: { create: { from: "student", by: stu.id, text: t, photos: pics } },
    },
  });
  await enqueueSheetEvent(db, "complaint", [
    istStamp(),
    orderId ? "#" + orderId.slice(-6) : "—",
    await customerIdFor(db, stu.id),
    stu.name,
    t.slice(0, 200),
    pics.length,
    "student",
  ]);
  publish([`orders:${stu.collegeId}`], { type: "complaint.message", payload: { complaintId: c.id } });
  void notifyOwner("New complaint", `${stu.name} (${stu.college.name}): "${t.slice(0, 160)}"${orderId ? ` — order #${orderId.slice(-4)}` : ""}`);
  flushSoon();
  return { ok: true as const, id: c.id };
}

export async function sendComplaintMessage(complaintId: string, text: string, photos?: string[]) {
  const t = text.trim();
  const pics = cleanPhotos(photos);
  // A photo on its own is a valid message — "here's what it looks like".
  if (!t && !pics.length) return { ok: false as const, error: "Type a message or attach a photo" };
  const s = await getSession();
  const c = await db.complaint.findUniqueOrThrow({ where: { id: complaintId } });
  if (c.status !== "open") return { ok: false as const, error: "Complaint is closed" };

  if (s?.mode === "customer") {
    const stu = await requireStudent();
    if (c.studentId !== stu.id) return { ok: false as const, error: "Not your complaint" };
    await db.complaintMessage.create({ data: { complaintId, from: "student", by: stu.id, text: t, photos: pics.length ? pics : undefined } });
    publish([`orders:${c.collegeId}`], { type: "complaint.message", payload: { complaintId } });
  } else {
    const st = await requireStaff(1);
    assertSameCollege(st, c.collegeId);
    await db.complaintMessage.create({ data: { complaintId, from: "staff", by: st.id, text: t, photos: pics.length ? pics : undefined } });
    await pushNotif(c.studentId, t ? `Staff replied to your complaint: "${t.slice(0, 80)}"` : "Staff sent photos on your complaint.", "status");
    if (pics.length) {
      const stu = await db.student.findUnique({ where: { id: c.studentId }, select: { phone: true } });
      if (stu) void sendWhatsAppPhotos(stu.phone, pics, t || undefined);
    }
    publish([`student:${c.studentId}`], { type: "complaint.message", payload: { complaintId } });
  }
  return { ok: true as const };
}

/* Staff-raised damage report against an order — the "we found this before we
   washed it" path. Opens a complaint thread the student can see and reply to,
   so the evidence and the conversation live in one place rather than in a
   WhatsApp chat nobody can audit later. */
export async function reportOrderDamage(orderId: string, input: { comment: string; photos: string[] }) {
  const st = await requireStaff(1);
  const comment = (input.comment || "").trim();
  const pics = cleanPhotos(input.photos);
  if (comment.length < 5) return { ok: false as const, error: "Describe what you found — this is the record if the student disputes it later" };
  if (pics.length < MIN_DAMAGE_PHOTOS) {
    return { ok: false as const, error: `Attach at least ${MIN_DAMAGE_PHOTOS} photos (${pics.length} so far)` };
  }

  const o = await db.order.findUnique({ where: { id: orderId }, include: { student: true } });
  if (!o) return { ok: false as const, error: "Order not found" };
  assertSameCollege(st, o.collegeId);

  const c = await db.complaint.create({
    data: {
      studentId: o.studentId, collegeId: o.collegeId, orderId: o.id, text: comment,
      messages: { create: { from: "staff", by: st.id, text: comment, photos: pics } },
    },
  });

  await pushNotif(o.studentId, `We noticed something on order #${o.id.slice(-4)} before washing: ${comment.slice(0, 120)}`, "status");
  void sendWhatsAppPhotos(o.student.phone, pics, `FabricFold — order #${o.id.slice(-4)}: ${comment.slice(0, 200)}`);
  await audit("Damage reported", `#${o.id.slice(-4)} · ${o.student.name} · ${pics.length} photos`, st.id);
  await enqueueSheetEvent(db, "complaint", [
    istStamp(),
    "#" + o.id.slice(-6),
    await customerIdFor(db, o.studentId),
    o.student.name,
    comment.slice(0, 200),
    pics.length,
    st.name,
  ]);
  publish([`student:${o.studentId}`, `orders:${o.collegeId}`], { type: "complaint.message", payload: { complaintId: c.id } });
  flushSoon();
  return { ok: true as const, id: c.id };
}

/* Free re-wash as the remedy for a complaint. Linked back to the complaint so
   the giveaway is always traceable to the grievance that justified it. */
export async function grantFreeReservice(complaintId: string) {
  const st = await requireStaff(2); // Manager+ — this is money out the door
  const c = await db.complaint.findUniqueOrThrow({ where: { id: complaintId } });
  assertSameCollege(st, c.collegeId);
  if (!c.orderId) return { ok: false as const, error: "This complaint isn't linked to an order" };
  if (c.redoOrderId) return { ok: false as const, error: "A free re-service was already given for this complaint" };

  const r = await redoOrder(c.orderId);
  if (!r.ok || !r.id) return { ok: false as const, error: r.error || "Couldn't create the re-service order" };

  /* Claim the complaint atomically before recording the redo — the check
     above ran before redoOrder(), so two concurrent clicks (or a retried
     request) could both pass it and both create a free re-service order,
     with the second write just overwriting the first's redoOrderId and
     losing any trace that a second one was ever given away. Scoping the
     update to redoOrderId still null means only the first caller's write
     actually lands; the loser can't silently give away a second one. */
  const claimed = await db.complaint.updateMany({ where: { id: complaintId, redoOrderId: null }, data: { redoOrderId: r.id } });
  if (claimed.count === 0) {
    return { ok: false as const, error: "A free re-service was already given for this complaint — this one wasn't linked; check the order queue" };
  }
  await db.complaintMessage.create({
    data: { complaintId, from: "staff", by: st.id, text: `Free re-service raised — order #${r.id.slice(-4)}, at no charge.` },
  });
  await pushNotif(c.studentId, `We've raised a free re-wash for you — order #${r.id.slice(-4)}, no charge.`, "status");
  await audit("Free re-service (complaint)", `complaint ${complaintId.slice(-6)} → #${r.id.slice(-4)}`, st.id);
  publish([`student:${c.studentId}`, `orders:${c.collegeId}`], { type: "complaint.message", payload: { complaintId } });
  return { ok: true as const, id: r.id };
}

export async function resolveComplaint(complaintId: string, resolution: string): Promise<{ ok: boolean; error?: string }> {
  const st = await requireStaff(1);
  const c = await db.complaint.findUniqueOrThrow({ where: { id: complaintId } });
  assertSameCollege(st, c.collegeId);
  const res = resolution.trim() || "Resolved by staff.";
  await db.complaint.update({ where: { id: complaintId }, data: { status: "resolved", resolvedAt: new Date() } });
  await db.complaintMessage.create({ data: { complaintId, from: "staff", by: st.id, text: "Resolved: " + res } });
  await pushNotif(c.studentId, "Your complaint was resolved: " + res, "status");
  publish([`student:${c.studentId}`, `orders:${c.collegeId}`], { type: "complaint.message", payload: { complaintId } });
  return { ok: true as const };
}
