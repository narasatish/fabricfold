import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffAdminClient from "./_components/AdminClient";

export default async function StaffAdminPage() {
  const staff = await requireStaff(3);

  const [appConfig, colleges, staffList, payslips] = await Promise.all([
    db.appConfig.findUnique({ where: { id: "main" } }),
    db.college.findMany({ include: { features: true } }),
    db.staff.findMany(),
    db.payslip.findMany({ include: { staff: true }, orderBy: { month: "desc" }, take: 20 }),
  ]);

  return (
    <div className="screen">
      <TopBar title="Admin" sub="" back={null} />
      <StaffAdminClient
        appConfig={appConfig}
        colleges={colleges}
        staff={staffList}
        payslips={payslips}
        currentRole={staff.role}
      />
    </div>
  );
}
