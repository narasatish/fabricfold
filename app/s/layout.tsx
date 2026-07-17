import { redirect } from "next/navigation";
import { getSession, requireStaff } from "@/lib/auth";
import { Svg } from "@/components/icons";
import { TabBar, RealtimeRefresh } from "@/components/chrome";
import { InstallPrompt } from "@/components/pwa";
import StaffTabBar from "./_components/StaffTabBar";
import { db } from "@/lib/db";

// Every staff screen is session-scoped — never statically prerender this segment.
export const dynamic = "force-dynamic";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session || session.mode !== "staff") {
    redirect("/login");
  }

  // Verify staff exists and get current data
  const staff = await requireStaff(1);

  // Get unresolved complaint count
  const openComplaints = await db.complaint.count({
    where: { status: "open" },
  });

  return (
    <>
      {children}
      <StaffTabBar openComplaints={openComplaints} role={staff.role} />
      <InstallPrompt />
      <RealtimeRefresh intervalMs={10000} />
    </>
  );
}
