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
    /* PNG only. The old icon.svg was a placeholder mark, and browsers prefer
       SVG when both are offered — so listing it would have kept the wrong
       logo in the tab no matter what the PNGs contained. */
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  /* Link previews. Students share fabricfold.in on WhatsApp far more than
     anywhere else, and without these a shared link renders as a bare grey URL.
     Set on the root layout so every page inherits a preview; pages with their
     own metadata override the title and description but keep the image. */
  openGraph: {
    type: "website",
    siteName: "FabricFold",
    title: "FabricFold",
    description: "Campus laundry & dry-cleaning",
    url: "https://fabricfold.in",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "FabricFold" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "FabricFold",
    description: "Campus laundry & dry-cleaning",
    images: ["/og.png"],
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
