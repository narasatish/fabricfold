import { redirect } from "next/navigation";
import { getSession, requireStudent, AuthError } from "@/lib/auth";
import { Svg } from "@/components/icons";
import { TabBar, RealtimeRefresh } from "@/components/chrome";
import { InstallPrompt } from "@/components/pwa";
import CustomerTabBar from "./_components/TabBar";
import { db } from "@/lib/db";

// Every customer screen is session-scoped — never statically prerender this segment.
export const dynamic = "force-dynamic";

export default async function CustomerLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session || session.mode !== "customer") {
    redirect("/login");
  }

  // Verify the account can still sign in — see the note in app/s/layout.tsx.
  let student;
  try {
    student = await requireStudent();
  } catch (e) {
    if (e instanceof AuthError) redirect("/login");
    throw e;
  }

  // Get unread notification count
  const unreadCount = await db.notification.count({
    where: { studentId: student.id, read: false },
  });

  return (
    <>
      {children}
      <CustomerTabBar unread={unreadCount} />
      <InstallPrompt />
      <RealtimeRefresh types={["order.status", "notification", "complaint.message"]} toastOn={{ "order.status": "Order updated", "notification": "", "complaint.message": "New message" }} />
    </>
  );
}
