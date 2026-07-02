import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/chrome";
import { PwaSetup } from "@/components/pwa";

export const metadata: Metadata = {
  title: "FabricFold",
  description: "Campus laundry & dry-cleaning",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#0f8a66",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <AppShell>{children}</AppShell>
        <PwaSetup vapidPublicKey={process.env.VAPID_PUBLIC_KEY} />
      </body>
    </html>
  );
}
