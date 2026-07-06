import type { Metadata } from "next";
import Link from "next/link";
import MarketingShell, { WHATSAPP } from "../_components/marketing/Shell";

export const metadata: Metadata = {
  title: "Contact FabricFold — students & colleges",
  description: "Get in touch with FabricFold. Students: reach us on WhatsApp or in the app. Colleges & communities: talk to us about bringing a managed laundry service to your campus.",
  alternates: { canonical: "https://fabricfold.in/contact" },
};

const CI = {
  chat: "M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-4-1L3 21l1.9-5.5a8.5 8.5 0 0 1 3.6-11.5 8.38 8.38 0 0 1 9 1.5 8.38 8.38 0 0 1 2.5 6Z",
  mail: "M4 4h16v16H4zM4 6l8 6 8-6",
  phone: "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z",
};
function Ic({ d }: { d: string }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{d.split("M").filter(Boolean).map((seg, i) => <path key={i} d={"M" + seg} />)}</svg>;
}

export default function Contact() {
  return (
    <MarketingShell active="/contact">
      <header className="mx m-sec tight" style={{ textAlign: "center" }}>
        <span className="m-kicker">Get in touch</span>
        <h1 className="m-h1" style={{ maxWidth: 680, margin: "18px auto 0" }}>We&apos;re easy to reach</h1>
        <p className="m-lead center">Whether you&apos;re a student with a question or a college looking to partner, pick whatever&apos;s easiest.</p>
      </header>

      <section className="m-sec" style={{ paddingTop: 0 }}>
        <div className="mx">
          <div className="m-contact">
            <a href={WHATSAPP} target="_blank" rel="noreferrer"><div className="m-cc"><div className="ic"><Ic d={CI.chat} /></div><h3>WhatsApp</h3><p>Fastest for anything</p><b>+91 80191 21966</b></div></a>
            <a href="mailto:support@fabricfold.in"><div className="m-cc"><div className="ic"><Ic d={CI.mail} /></div><h3>Email</h3><p>For details &amp; enquiries</p><b>support@fabricfold.in</b></div></a>
            <a href="tel:+918019121966"><div className="m-cc"><div className="ic"><Ic d={CI.phone} /></div><h3>Call</h3><p>Mon–Sat, 9am–7pm</p><b>+91 80191 21966</b></div></a>
          </div>
        </div>
      </section>

      <section className="m-sec alt">
        <div className="mx">
          <div className="m-split">
            <div>
              <h2 className="m-h2">For colleges &amp; communities</h2>
              <p className="m-lead">Thinking of bringing FabricFold to your campus, hostel or community? Message us with a few details and we&apos;ll get back quickly:</p>
              <ul className="m-check">
                <li>Your college / community name and location</li>
                <li>Roughly how many students or residents</li>
                <li>How laundry is handled there today</li>
              </ul>
              <div className="m-cta">
                <a href="mailto:support@fabricfold.in?subject=FabricFold%20for%20our%20campus&body=College%2Fcommunity%20name%3A%0ALocation%3A%0AApprox%20students%2Fresidents%3A%0ACurrent%20laundry%20setup%3A" className="btn">Email a partnership enquiry</a>
                <a href={WHATSAPP} target="_blank" rel="noreferrer" className="btn ghost">Or WhatsApp us</a>
              </div>
            </div>
            <div className="m-split-media">
              <div className="m-panel">
                <div className="label" style={{ color: "var(--teal-dark)" }}>Already a FabricFold user?</div>
                <p style={{ fontSize: 15, color: "var(--ink-2)", lineHeight: 1.6, marginTop: 8 }}>
                  For order-specific help, log in and raise it under Help &amp; complaints — it goes straight to the counter staff and you can follow the conversation in the app.
                </p>
                <Link href="/login" className="btn mt16" style={{ width: "auto", padding: "0 22px" }}>Open the app</Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
