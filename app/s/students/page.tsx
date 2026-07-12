import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StudentsClient from "./_components/StudentsClient";

export default async function StaffStudentsPage() {
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect("/login");
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");

  const [rows, colleges] = await Promise.all([
    db.student.findMany({
      orderBy: { createdAt: "desc" },
      select: {
        id: true, name: true, phone: true, credits: true, lifetimePieces: true, collegeId: true,
        subscription: { select: { active: true } },
      },
    }),
    db.college.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }),
  ]);

  const students = rows.map((r) => ({
    id: r.id, name: r.name, phone: r.phone,
    credits: Number(r.credits), lifetimePieces: r.lifetimePieces,
    collegeId: r.collegeId, subActive: !!r.subscription?.active,
  }));

  return (
    <div className="screen">
      <TopBar title="Students" sub={`${students.length} total`} back="/s" />
      <StudentsClient students={students} colleges={colleges} staffRole={staff.role} />
    </div>
  );
}
