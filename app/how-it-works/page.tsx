import type { Metadata } from "next";
import Link from "next/link";
import MarketingShell from "../_components/marketing/Shell";

export const metadata: Metadata = {
  title: "How it works — FabricFold campus laundry",
  description: "How FabricFold works for students: book on your phone, drop at the counter, every garment QR-tagged, track live, and collect with a one-time code. Pay by UPI, cash or store credit.",
  alternates: { canonical: "https://fabricfold.in/how-it-works" },
};

const STEPS = [
  ["Pre-book from your phone", "Open the app, pick a service — wash & iron, iron only, or dry clean — and count the pieces you'll bring. You get an order ID to show at the counter. No standing in a queue to find out what it costs."],
  ["Drop at the counter", "Bring your bag to the FabricFold counter on campus. Our staff confirm the item count with you, weigh the load, and tag every single garment with its own QR code so nothing gets mixed up in the wash."],
  ["We clean it", "Your clothes are washed, ironed or dry-cleaned. The status on your phone moves from Received to Processing so you always know where things stand — no need to ask."],
  ["Collect with your code", "The moment your laundry is ready, you get a notification and a 4-digit pickup code. Show the code at the counter, grab your clothes, done. Standard orders are ready in about 48 hours; same-day express is available."],
];

/* FAQPage structured data — the answers here MUST match the visible <details>
   text below verbatim, or Google will ignore (and can penalise) the markup. */
const faqLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: [
    { "@type": "Question", name: "Do I need to download an app?", acceptedAnswer: { "@type": "Answer", text: "No. FabricFold runs in your phone's web browser. You can add it to your home screen so it feels like an app, but there's nothing to install from an app store." } },
    { "@type": "Question", name: "How do I sign up?", acceptedAnswer: { "@type": "Answer", text: "With your phone number. You'll get a one-time code by SMS, pick your campus or community, and you're in. No email or password to remember." } },
    { "@type": "Question", name: "What if a garment is damaged or missing?", acceptedAnswer: { "@type": "Answer", text: "Every piece is QR-tagged at drop-off, so missing items are rare. If something is damaged or lost, our staff issue compensation as store credit (or cash, at a manager's discretion) after checking the order." } },
    { "@type": "Question", name: "What if I'm not happy with the cleaning?", acceptedAnswer: { "@type": "Answer", text: "We'll re-do it free. Just tell the counter or raise it in the app — no forms, no argument." } },
    { "@type": "Question", name: "How fast is it?", acceptedAnswer: { "@type": "Answer", text: "Standard orders come back in about 48 hours. Need it sooner? Same-day express is available for a small surcharge." } },
  ],
};

export default function HowItWorks() {
  return (
    <MarketingShell active="/how-it-works">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqLd) }} />
      <header className="mx m-sec tight" style={{ textAlign: "center" }}>
        <span className="m-kicker">For students &amp; residents</span>
        <h1 className="m-h1" style={{ maxWidth: 760, margin: "18px auto 0" }}>From your room to clean clothes, in four steps</h1>
        <p className="m-lead center">Laundry shouldn&apos;t eat your day. Here&apos;s exactly how FabricFold works, start to finish.</p>
      </header>

      <section className="m-sec" style={{ paddingTop: 0 }}>
        <div className="mx mkt-narrow">
          <div className="m-steps">
            {STEPS.map(([h, p], i) => (
              <div className="m-step" key={i}>
                <div className="num">{i + 1}</div>
                <div><h3>{h}</h3><p>{p}</p></div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="m-sec alt">
        <div className="mx">
          <div className="m-split">
            <div>
              <h2 className="m-h2">Paying is simple, and you get a real invoice</h2>
              <p className="m-lead">Pay whichever way suits you. Nothing is collected until your order is ready, and you&apos;re never overcharged for a count you didn&apos;t agree to.</p>
              <ul className="m-check">
                <li>Pay by UPI in the app, or cash at the counter</li>
                <li>Use store credit from past compensation or refunds</li>
                <li>UPI payments come with a downloadable GST invoice</li>
                <li>Prices are per item and confirmed with you at drop-off</li>
              </ul>
            </div>
            <div className="m-split-media">
              <div className="m-panel">
                <div className="label" style={{ color: "var(--teal-dark)" }}>Where you see prices</div>
                <p style={{ fontSize: 15, color: "var(--ink-2)", lineHeight: 1.6, marginTop: 8 }}>
                  Your campus&apos;s exact rate card lives inside the app — you&apos;ll see it once you log in and select your college or community, because pricing is set per site.
                </p>
                <Link href="/login" className="btn mt16" style={{ width: "auto", padding: "0 22px" }}>Log in to see your rates</Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="m-sec">
        <div className="mx">
          <h2 className="m-h2 center">Common questions</h2>
          <div className="m-faq">
            <details><summary>Do I need to download an app?</summary><p>No. FabricFold runs in your phone&apos;s web browser. You can add it to your home screen so it feels like an app, but there&apos;s nothing to install from an app store.</p></details>
            <details><summary>How do I sign up?</summary><p>With your phone number. You&apos;ll get a one-time code by SMS, pick your campus or community, and you&apos;re in. No email or password to remember.</p></details>
            <details><summary>What if a garment is damaged or missing?</summary><p>Every piece is QR-tagged at drop-off, so missing items are rare. If something is damaged or lost, our staff issue compensation as store credit (or cash, at a manager&apos;s discretion) after checking the order.</p></details>
            <details><summary>What if I&apos;m not happy with the cleaning?</summary><p>We&apos;ll re-do it free. Just tell the counter or raise it in the app — no forms, no argument.</p></details>
            <details><summary>How fast is it?</summary><p>Standard orders come back in about 48 hours. Need it sooner? Same-day express is available for a small surcharge.</p></details>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
