import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import Landing from "./_components/Landing";

export const metadata: Metadata = {
  title: "FabricFold — Campus Laundry & Dry-Cleaning | Wash & Iron from ₹15/piece",
  description:
    "Campus laundry for hostel students at BVRIT & St Mary's. Pre-book from your phone, QR-tagged garments, live tracking, pickup OTP. Wash & iron ₹15/piece, 48-hour turnaround, same-day express. Annual plans available.",
  keywords: ["campus laundry", "hostel laundry service", "laundry BVRIT", "dry cleaning college", "wash and iron per piece", "student laundry Telangana"],
  alternates: { canonical: "https://fabricfold.in" },
  openGraph: {
    title: "FabricFold — Campus Laundry & Dry-Cleaning",
    description: "Drop at the counter, track every piece, collect with an OTP. Wash & iron from ₹15/piece.",
    type: "website",
    locale: "en_IN",
    url: "https://fabricfold.in",
    siteName: "FabricFold",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "FabricFold",
  url: "https://fabricfold.in",
  description: "Campus laundry and dry-cleaning service for hostel students. Per-piece pricing, live order tracking, QR-tagged garments.",
  areaServed: "Telangana, India",
  telephone: "+918019121966",
  priceRange: "₹10–₹350 per piece",
  makesOffer: [
    { "@type": "Offer", name: "Wash & Iron", price: "15", priceCurrency: "INR" },
    { "@type": "Offer", name: "Annual subscription — 34 cycles × 7 kg", price: "8024", priceCurrency: "INR" },
  ],
};

export default async function Root() {
  const s = await getSession();
  if (s?.mode === "customer") redirect("/c");
  if (s?.mode === "staff") redirect("/s");
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Landing />
    </>
  );
}
