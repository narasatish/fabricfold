import { redirect } from "next/navigation";
import { getSession, requireStudent, AuthError } from "@/lib/auth";
import { RealtimeRefresh } from "@/components/chrome";
import { InstallPrompt } from "@/components/pwa";
import { SafePaymentBanner } from "@/components/safe-payment-banner";
import { AnnouncementBanner } from "@/components/announcement-banner";
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

  // This layout wraps every /c page, so these two reads run on every
  // customer page load — parallelized like the other hot student-facing
  // pages (app/c/page.tsx), not sequential round-trips.
  const [unreadCount, appConfig] = await Promise.all([
    db.notification.count({ where: { studentId: student.id, read: false } }),
    db.appConfig.findUnique({ where: { id: "main" } }),
  ]);
  const payeeName = (appConfig?.payment as unknown as { payeeName?: string } | null)?.payeeName || "";
  const banner = (appConfig?.settings as unknown as { announcementBanner?: { text: string; active: boolean } } | null)?.announcementBanner;
  const bannerText = banner?.active && banner.text?.trim() ? banner.text.trim().slice(0, 300) : null;

  return (
    <>
      <AnnouncementBanner text={bannerText} />
      <SafePaymentBanner payeeName={payeeName} />
      {children}
      <CustomerTabBar unread={unreadCount} />
      <InstallPrompt />
      <RealtimeRefresh types={["order.status", "notification", "complaint.message"]} toastOn={{ "order.status": "Order updated", "notification": "", "complaint.message": "New message" }} />
    </>
  );
}
