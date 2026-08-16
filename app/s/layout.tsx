import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession, requireStaff } from "@/lib/auth";
import { Svg } from "@/components/icons";
import { TabBar, RealtimeRefresh } from "@/components/chrome";
import { InstallPrompt } from "@/components/pwa";
import { OfflineBanner } from "@/components/offline";
import StaffTabBar from "./_components/StaffTabBar";
import { db } from "@/lib/db";

// Every staff screen is session-scoped — never statically prerender this segment.
export const dynamic = "force-dynamic";

/* Staff screens advertise their OWN manifest.

   The root manifest starts at /c, so without this every page under /s pointed
   installers at the student app: "Add to home screen" from the counter phone,
   or an APK built from these pages, would launch staff into /c. Same icons and
   colours, different id and start_url — which is what makes Android treat it
   as a separate installable app rather than a second copy of the first.

   Scope stays "/" deliberately. Narrowing it to "/s" would put /login outside
   the app, so an expired session would dump staff into a browser tab instead
   of showing the sign-in screen inside the installed app. */
export const metadata: Metadata = { manifest: "/staff.webmanifest" };

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
      {/* Above the content: when the connection drops mid-queue the staff
          member must see it before they wonder why a tap did nothing. */}
      <OfflineBanner />
      {children}
      <StaffTabBar openComplaints={openComplaints} role={staff.role} />
      <InstallPrompt />
      <RealtimeRefresh intervalMs={10000} />
    </>
  );
}
