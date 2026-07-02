"use client";
import { usePathname } from "next/navigation";
import { TabBar } from "@/components/chrome";

export default function CustomerTabBar({ unread }: { unread: number }) {
  const pathname = usePathname();

  const getActive = () => {
    if (pathname === "/c") return "home";
    if (pathname.startsWith("/c/orders")) return "orders";
    if (pathname.startsWith("/c/wallet")) return "wallet";
    if (pathname.startsWith("/c/profile")) return "profile";
    return "home";
  };

  return (
    <TabBar
      active={getActive()}
      tabs={[
        { key: "home", label: "Home", icon: "home", href: "/c" },
        { key: "orders", label: "Orders", icon: "bag", href: "/c/orders" },
        { key: "wallet", label: "Wallet", icon: "wallet", href: "/c/wallet" },
        { key: "profile", label: "Profile", icon: "user", href: "/c/profile" },
      ]}
    />
  );
}
