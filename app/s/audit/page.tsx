import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffAuditClient from "./_components/AuditClient";

export default async function StaffAuditPage() {
  const staff = await requireStaff(3);

  const logs = await db.auditLog.findMany({
    orderBy: { at: "desc" },
  });

  return (
    <div className="screen">
      <TopBar title="Audit log" sub="" back={undefined} />
      <StaffAuditClient logs={logs} />
    </div>
  );
}
