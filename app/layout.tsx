import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AppShell } from "@/components/chrome";
import { PwaSetup } from "@/components/pwa";

export const metadata: Metadata = {
  metadataBase: new URL("https://fabricfold.in"),
  title: "FabricFold",
  description: "Campus laundry & dry-cleaning",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "FabricFold" },
  icons: {
    icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }, { url: "/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#0e9271",
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
