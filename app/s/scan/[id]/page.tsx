import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";

/* Target of the QR shown on the student's own profile (app/c/profile).
   The URL segment is a one-time scan TOKEN (lib/actions/students.ts,
   createScanCode), not the student's id — the QR is regenerated fresh
   every time the student opens it, and a token works exactly once, so a
   screenshot or a stale scan can't be reused later at the counter.
   Encoding a real URL (instead of a bare token) means scanning with ANY
   camera app — not just the in-app scanner at /s/scan — still does
   something sane: it opens this link, which carries the normal staff
   auth gate before consuming the token and handing off to the real
   customer page. */
export default async function ScanRedirectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: token } = await params;
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect(`/login?next=/s/scan/${token}`);
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");

  const otp = await db.otp.findFirst({ where: { purpose: "scan", code: token, usedAt: null, expiresAt: { gt: new Date() } } });
  if (!otp || !otp.refId) redirect("/s/scan?error=expired");

  const student = await db.student.findUnique({ where: { id: otp.refId }, select: { collegeId: true } });
  if (!student) redirect("/s/customers");
  if (staff.collegeId && staff.collegeId !== student.collegeId) redirect("/s/students");

  // Atomic consume — scoped update so a double-scan (two staff, or the same
  // camera firing twice) can only win the race once; the loser just gets
  // sent straight to the account anyway, so no error is needed.
  await db.otp.updateMany({ where: { id: otp.id, usedAt: null }, data: { usedAt: new Date() } });

  redirect(`/s/customers/${otp.refId}`);
}
