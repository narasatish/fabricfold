import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import Home from "./_components/marketing/Home";

export const metadata: Metadata = {
  title: "FabricFold — Campus & Community Laundry Service",
  description:
    "FabricFold runs the laundry counter on campuses, hostels and communities. Students book from their phone, every garment is QR-tagged, orders are tracked live, and pickup is by one-time code. Bring FabricFold to your campus.",
  keywords: ["campus laundry service", "college laundry", "hostel laundry", "community laundry", "laundry counter on campus", "student laundry Telangana", "laundry vendor for colleges"],
  alternates: { canonical: "https://fabricfold.in" },
  openGraph: {
    title: "FabricFold — Campus & Community Laundry Service",
    description: "We run the laundry counter on your campus or community. Book, track and collect from your phone.",
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
  description: "Campus and community laundry & dry-cleaning service. On-site counter, QR-tagged garments, live order tracking, and digital records for colleges, hostels and communities.",
  areaServed: "Telangana, India",
  telephone: "+918019121966",
  email: "support@fabricfold.in",
  knowsAbout: ["campus laundry", "hostel laundry", "community laundry", "dry cleaning", "garment tracking"],
};

export default async function Root() {
  const s = await getSession();
  if (s?.mode === "customer") redirect("/c");
  if (s?.mode === "staff") redirect("/s");
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Home />
    </>
  );
}
