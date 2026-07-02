import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffComplaintsClient from "./_components/ComplaintsClient";

export default async function StaffComplaintsPage() {
  await requireStaff(1);

  const [openComplaints, resolvedComplaints] = await Promise.all([
    db.complaint.findMany({
      where: { status: "open" },
      include: { student: true, messages: true },
      orderBy: { createdAt: "desc" },
    }),
    db.complaint.findMany({
      where: { status: "resolved" },
      include: { student: true },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);

  return (
    <div className="screen">
      <TopBar title="Complaints" sub="" back={null} />
      <StaffComplaintsClient open={openComplaints} resolved={resolvedComplaints} />
    </div>
  );
}
