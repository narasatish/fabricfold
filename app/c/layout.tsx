import { redirect } from "next/navigation";
import { getSession, requireStudent } from "@/lib/auth";
import { Svg } from "@/components/icons";
import { TabBar, RealtimeRefresh } from "@/components/chrome";
import CustomerTabBar from "./_components/TabBar";
import { db } from "@/lib/db";

// Every customer screen is session-scoped — never statically prerender this segment.
export const dynamic = "force-dynamic";

export default async function CustomerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session || session.mode !== "customer") {
    redirect("/login");
  }

  // Verify student exists
  const student = await requireStudent();

  // Get unread notification count
  const unreadCount = await db.notification.count({
    where: { studentId: student.id, read: false },
  });

  return (
    <>
      {children}
      <CustomerTabBar unread={unreadCount} />
      <RealtimeRefresh types={["order.status", "notification", "complaint.message"]} toastOn={{ "order.status": "Order updated", "notification": "", "complaint.message": "New message" }} />
    </>
  );
}
