import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffComplaintsClient from "./_components/ComplaintsClient";

export default async function StaffComplaintsPage() {
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect("/login");
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");

  // Uncapped + full-relation includes here would slow down with every year of
  // history; 300 most recent is comfortably more than a day's review needs,
  // and selecting only the rendered fields avoids pulling entire
  // Student/College rows (credits, passwordHash, etc.) just for a name.
  // Scoped to the staff member's own campus — complaint text names people and
  // incidents, exactly the kind of content that must never cross campuses.
  const complaints = await db.complaint.findMany({
    where: staff.collegeId ? { collegeId: staff.collegeId } : undefined,
    select: {
      id: true, studentId: true, orderId: true, text: true, status: true, at: true,
      student: { select: { id: true, name: true, college: { select: { name: true } } } },
      messages: { orderBy: { at: "asc" }, select: { id: true, from: true, text: true, at: true } },
    },
    orderBy: { at: "desc" },
    take: 300,
  });

  const plain = complaints.map((c) => ({
    id: c.id,
    studentId: c.studentId,
    orderId: c.orderId,
    text: c.text,
    status: c.status,
    at: c.at.getTime(),
    student: { id: c.student.id, name: c.student.name, college: c.student.college?.name || "" },
    messages: c.messages.map((m) => ({ id: m.id, from: m.from, text: m.text, at: m.at.getTime() })),
  }));

  return (
    <div className="screen">
      <TopBar title="Complaints" />
      <StaffComplaintsClient complaints={plain} staffRole={staff.role} />
    </div>
  );
}
