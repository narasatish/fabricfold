import { redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffHomeClient from "./_components/HomeClient";

export default async function StaffHomePage() {
  const staff = await requireStaff(1);

  // Fetch orders in actionable statuses
  const orders = await db.order.findMany({
    where: { status: { in: ["draft", "received", "processing", "ready"] } },
    include: { student: true, college: true },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  // Fetch pending subscription OTPs/requests
  const pendingSubs = await db.otp.findMany({
    where: { purpose: "subscription" },
    include: { student: true },
  });

  return (
    <div className="screen">
      <TopBar title="Counter" sub={`Welcome, ${staff.name.split(" ")[0]}`} />
      <StaffHomeClient staff={staff} orders={orders} pendingSubs={pendingSubs} />
    </div>
  );
}
