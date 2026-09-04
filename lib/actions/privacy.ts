"use server";
/* Data export and erasure.

   A student can take a copy of everything held about them, and ask to be
   forgotten. The second one has a genuine conflict at its heart, so it is
   worth stating plainly:

   Financial records — payments, invoices, credit notes — are immutable by
   database trigger and must be retained for tax purposes. They cannot be
   deleted, and pretending otherwise would be a lie told to someone exercising
   a legal right.

   So erasure here means ANONYMISATION: every field that identifies a person is
   overwritten, while the rows that make the accounts balance stay. Afterwards
   the ledger still sums correctly but no longer names anybody. That is the
   honest reading of "delete my data" for a business that must keep books, and
   the student is told exactly that rather than being promised a deletion that
   cannot happen. */
import { db } from "../db";
import { requireStudent, requireStaff, assertSameCollege, clearSession } from "../auth";
import { audit } from "../notify";

/** Everything held about the signed-in student, as plain JSON. */
export async function exportMyData() {
  const stu = await requireStudent();

  const [orders, payments, complaints, bags, credits, compensations, notifications] = await Promise.all([
    db.order.findMany({ where: { studentId: stu.id }, orderBy: { createdAt: "desc" } }),
    db.payment.findMany({ where: { studentId: stu.id }, orderBy: { at: "desc" } }),
    db.complaint.findMany({ where: { studentId: stu.id }, include: { messages: true }, orderBy: { at: "desc" } }),
    db.bag.findMany({ where: { studentId: stu.id }, orderBy: { issuedAt: "desc" } }),
    db.creditUse.findMany({ where: { studentId: stu.id }, orderBy: { at: "desc" } }),
    db.compensation.findMany({ where: { studentId: stu.id }, orderBy: { at: "desc" } }),
    db.notification.findMany({ where: { studentId: stu.id }, orderBy: { at: "desc" } }),
  ]);
  const subscription = await db.subscription.findUnique({
    where: { studentId: stu.id },
    include: { cycleLog: true },
  });

  /* Decimal and Date do not survive JSON.stringify usefully, so normalise
     rather than hand the student "{}" where an amount should be. */
  const plain = JSON.parse(JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      note: "Everything FabricFold holds about you. Financial records are retained for tax purposes even after an erasure request — see the privacy page.",
      you: {
        id: stu.id, name: stu.name, phone: stu.phone,
        campus: stu.college?.name ?? null,
        credits: stu.credits, lifetimePieces: stu.lifetimePieces,
        washDay: stu.washDay, joinedAt: stu.createdAt,
        hasPasscode: !!stu.passwordHash, // never the passcode or its hash
      },
      subscription, orders, payments, complaints, bags,
      creditUses: credits, compensations, notifications,
    },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
  ));

  return { ok: true as const, data: plain };
}

/* Fields overwritten on erasure. Kept as one list so nothing is missed by
   editing the function and forgetting a column. */
function anonymisedFields(id: string) {
  return {
    name: "Deleted student",
    // phone is UNIQUE, so it needs a value that cannot collide and cannot be
    // dialled — not null, which would break the unique index on a second erasure
    phone: `deleted-${id}`,
    passwordHash: null,
    passwordSalt: null,
    passwordSetAt: null,
    sessionEpoch: { increment: 1 }, // kill any live session immediately
    anonymisedAt: new Date(),
  };
}

/** A student erases themselves. Irreversible. */
export async function eraseMyData(confirmation: string) {
  const stu = await requireStudent();
  if (confirmation.trim().toUpperCase() !== "DELETE") {
    return { ok: false as const, error: 'Type DELETE to confirm — this cannot be undone' };
  }
  if (stu.anonymisedAt) return { ok: false as const, error: "This account has already been erased" };

  await db.$transaction(async (tx) => {
    // Notifications are pure PII with no accounting value — actually delete them.
    await tx.notification.deleteMany({ where: { studentId: stu.id } });
    // Complaint text can name people; blank it but keep the thread structure.
    const threads = await tx.complaint.findMany({ where: { studentId: stu.id }, select: { id: true } });
    await tx.complaintMessage.updateMany({
      where: { complaintId: { in: threads.map((t) => t.id) } },
      data: { text: "[removed at the student's request]" },
    });
    await tx.student.update({ where: { id: stu.id }, data: anonymisedFields(stu.id) });
  });

  await audit("Data erased (student request)", `student ${stu.id} anonymised`, "self-service");
  await clearSession();
  return { ok: true as const };
}

/** Staff erase a student on their behalf — a request made at the counter. */
export async function eraseStudentData(studentId: string, reason: string) {
  const st = await requireStaff(3); // Admin+
  const note = (reason || "").trim();
  if (note.length < 3) return { ok: false as const, error: "Give a reason — erasure is irreversible and auditable" };

  const stu = await db.student.findUnique({ where: { id: studentId } });
  if (!stu) return { ok: false as const, error: "Student not found" };
  assertSameCollege(st, stu.collegeId);
  if (stu.anonymisedAt) return { ok: false as const, error: "That account has already been erased" };

  await db.$transaction(async (tx) => {
    await tx.notification.deleteMany({ where: { studentId: stu.id } });
    const threads = await tx.complaint.findMany({ where: { studentId: stu.id }, select: { id: true } });
    await tx.complaintMessage.updateMany({
      where: { complaintId: { in: threads.map((t) => t.id) } },
      data: { text: "[removed at the student's request]" },
    });
    await tx.student.update({ where: { id: stu.id }, data: anonymisedFields(stu.id) });
  });

  await audit("Data erased (staff)", `${stu.name} (${stu.id}) anonymised — ${note}`, st.id);
  return { ok: true as const };
}
