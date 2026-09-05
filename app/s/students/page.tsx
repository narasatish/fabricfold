import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import StudentsClient from "./_components/StudentsClient";

export default async function StaffStudentsPage() {
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect("/login");
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");

  // A campus-scoped staffer's own client-side campus filter only changed what
  // was DISPLAYED — the full roster of every other campus (names, phones,
  // wallet credit) was already sent to the browser in the RSC payload before
  // that filter ever ran. Scope it at the query itself, the same fix already
  // applied to searchStudents().
  const scope = staff.collegeId ? { collegeId: staff.collegeId } : {};
  const [rows, colleges] = await Promise.all([
    db.student.findMany({
      where: scope,
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, phone: true, credits: true, lifetimePieces: true, collegeId: true,
        subscription: { select: { active: true } },
        bags: { where: { status: "active" }, select: { code: true }, take: 1 },
      },
    }),
    /* Every college, including removed ones. A student still belongs to a
       campus after it is deactivated, and showing "-" made it look as though
       their record was broken. Scoped staff only need — and only should
       see — their own campus in this list (it also feeds the bulk-import
       target dropdown, which has no business offering another campus). */
    db.college.findMany({
      where: staff.collegeId ? { id: staff.collegeId } : {},
      select: { id: true, name: true, active: true },
      orderBy: [{ active: "desc" }, { name: "asc" }],
    }),
  ]);

  const students = rows.map((r) => ({
    id: r.id, displayId: r.bags[0]?.code ?? r.id, name: r.name, phone: r.phone,
    credits: Number(r.credits), lifetimePieces: r.lifetimePieces,
    collegeId: r.collegeId, subActive: !!r.subscription?.active,
  }));

  return (
    <div className="screen">
      <StudentsClient students={students} colleges={colleges} staffRole={staff.role} />
    </div>
  );
}
