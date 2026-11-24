import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";

/* Target of the QR shown on the student's own profile (app/c/profile).
   Encoding a real URL here (instead of a bare id) means scanning with ANY
   camera app — not just the in-app scanner at /s/scan — still does
   something sane: it opens this link, which carries the normal staff
   auth + same-college gate (copied from app/s/customers/[id]/page.tsx,
   since this page bypasses that page's own query and must re-check) before
   handing off to the real customer page. */
export default async function ScanRedirectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect(`/login?next=/s/scan/${id}`);
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");

  const student = await db.student.findUnique({ where: { id }, select: { collegeId: true } });
  if (!student) redirect("/s/customers");
  if (staff.collegeId && staff.collegeId !== student.collegeId) redirect("/s/students");

  redirect(`/s/customers/${id}`);
}
