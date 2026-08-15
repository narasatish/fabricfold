import type { Metadata } from "next";
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
    /* Must be repeated here. A page-level `openGraph` REPLACES the root
       layout's object rather than merging into it, so declaring one without
       images silently drops the site-wide og.png — which is how the homepage,
       the single most-shared URL, ended up with no preview image on WhatsApp
       while every other page had one. */
    images: [{ url: "/og.png", width: 1200, height: 630, alt: "FabricFold" }],
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  // DryCleaningOrLaundry is the exact schema.org type for a laundry business —
  // more specific than LocalBusiness, which helps local + service search.
  "@type": "DryCleaningOrLaundry",
  name: "FabricFold",
  legalName: "FabricFold Laundry Solutions",
  url: "https://fabricfold.in",
  logo: "https://fabricfold.in/icon-512.png",
  image: "https://fabricfold.in/icon-512.png",
  description: "Campus and community laundry & dry-cleaning service. On-site counter, QR-tagged garments, live order tracking, and digital records for colleges, hostels and communities.",
  areaServed: { "@type": "State", name: "Telangana", containedInPlace: { "@type": "Country", name: "India" } },
  address: { "@type": "PostalAddress", addressRegion: "Telangana", addressCountry: "IN" },
  telephone: "+918019121966",
  email: "support@fabricfold.in",
  priceRange: "₹₹",
  currenciesAccepted: "INR",
  paymentAccepted: "Cash, UPI",
  openingHoursSpecification: {
    "@type": "OpeningHoursSpecification",
    dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    opens: "09:00", closes: "19:00",
  },
  knowsAbout: ["campus laundry", "hostel laundry", "community laundry", "dry cleaning", "wash and fold", "wash and iron", "garment tracking"],
};

/* fabricfold.in always shows the marketing site — even for a logged-in staff or
   customer. The app is reached via the "Open app" button (which /login forwards
   to /c or /s when a session exists). Previously this redirected logged-in users
   straight into the app, so the owner's own device opened the staff console
   instead of the public website. */
export default function Root() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <Home />
    </>
  );
}
