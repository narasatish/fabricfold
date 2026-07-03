import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar, RealtimeRefresh } from "@/components/chrome";
import StaffComplaintsClient from "./_components/ComplaintsClient";

export default async function StaffComplaintsPage() {
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect("/login");
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");

  const complaints = await db.complaint.findMany({
    include: { student: { include: { college: true } }, messages: { orderBy: { at: "asc" } } },
    orderBy: { at: "desc" },
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
      <RealtimeRefresh types={["complaint.message"]} />
      <StaffComplaintsClient complaints={plain} staffRole={staff.role} />
    </div>
  );
}
