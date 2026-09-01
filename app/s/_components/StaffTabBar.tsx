"use client";
import { usePathname } from "next/navigation";
import { TabBar } from "@/components/chrome";
import type { IconName } from "@/components/icons";

export default function StaffTabBar({ openComplaints, role, canReports = true }: { openComplaints: number; role: number; canReports?: boolean }) {
  const pathname = usePathname();

  const tabs: { key: string; label: string; icon: IconName; href: string; badge?: number }[] = [
    { key: "s-home", label: "Home", icon: "home", href: "/s" },
    { key: "s-complaints", label: "Complaints", icon: "chat", href: "/s/complaints", badge: openComplaints > 0 ? openComplaints : undefined },
    // Reports is a named tool now — no tab for staff who cannot open it.
    ...(canReports ? [{ key: "s-reports", label: "Reports", icon: "layers" as const, href: "/s/reports" }] : []),
  ];

  if (role >= 3) {
    tabs.push({ key: "s-admin", label: "Admin", icon: "settings", href: "/s/admin" });
  }

  const active = pathname === "/s" ? "s-home" : pathname.split("/").slice(0, 3).join("-");

  return <TabBar tabs={tabs} active={active} />;
}
