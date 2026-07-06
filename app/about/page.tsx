import type { Metadata } from "next";
import MarketingShell, { WHATSAPP } from "../_components/marketing/Shell";

export const metadata: Metadata = {
  title: "About FabricFold — campus & community laundry",
  description: "FabricFold started with a simple hostel problem: laundry that was slow, unreliable and impossible to track. We run managed laundry counters on campuses and communities across Telangana.",
  alternates: { canonical: "https://fabricfold.in/about" },
};

export default function About() {
  return (
    <MarketingShell active="/about">
      <header className="mx m-sec tight" style={{ textAlign: "center" }}>
        <span className="m-kicker">About us</span>
        <h1 className="m-h1" style={{ maxWidth: 720, margin: "18px auto 0" }}>We started with one annoying hostel problem</h1>
      </header>

      <section className="m-sec" style={{ paddingTop: 8 }}>
        <div className="mx m-prose">
          <p>
            Anyone who has lived in a hostel knows the laundry routine: hand over a pile of clothes, get a scrap of
            paper with a number on it, and hope everything comes back — clean, complete, and roughly when you were told.
            Too often it didn&apos;t. Clothes went missing, prices were a mystery until the end, and there was no one to
            hold accountable when something went wrong.
          </p>
          <p>
            FabricFold was built to fix exactly that. We don&apos;t just wash clothes — we run the whole laundry operation
            on-site, with the kind of tracking and records that make it dependable. Every garment gets a tag. Every order
            is booked, priced and tracked in an app. Every payment produces a proper record. Students always know what
            they&apos;re paying and when their clothes will be ready, and the colleges we work with get a real vendor
            instead of an informal cash arrangement.
          </p>

          <h2 className="m-h2">What we care about</h2>
          <p>
            <strong>Reliability.</strong> If we say 48 hours, we mean it. If something isn&apos;t right, we re-do it free.
          </p>
          <p>
            <strong>Transparency.</strong> No hidden charges, no guessing. Prices are set per campus and shown in the app,
            and every order and invoice is on record.
          </p>
          <p>
            <strong>Care for your clothes.</strong> QR tagging keeps orders separate, and our compensation policy means a
            damaged or lost item is made right, not shrugged off.
          </p>

          <h2 className="m-h2">Where we are</h2>
          <p>
            We currently run on campuses in Telangana and are expanding to more colleges, hostels and residential
            communities. If your campus isn&apos;t served yet, tell us — student and resident demand is genuinely how we
            decide where to go next.
          </p>
        </div>
      </section>

      <section className="m-sec alt">
        <div className="mx">
          <div className="m-band">
            <h2>Want FabricFold where you are?</h2>
            <p>Whether you&apos;re a student who wishes your hostel had this, or an administrator who wants to set it up — we&apos;d love to hear from you.</p>
            <a href={WHATSAPP} target="_blank" rel="noreferrer" className="btn">Get in touch</a>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
