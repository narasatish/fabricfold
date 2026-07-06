import type { Metadata } from "next";
import MarketingShell, { WHATSAPP } from "../_components/marketing/Shell";

export const metadata: Metadata = {
  title: "For colleges & communities — partner with FabricFold",
  description: "Bring a managed laundry service to your campus, hostel or community. FabricFold sets up the counter, staff, garment tagging and the app, and gives you transparent digital records. Pricing tailored per site.",
  alternates: { canonical: "https://fabricfold.in/partners" },
};

const SETUP = [
  ["An on-site counter", "We set up a staffed drop-off and collection point inside your campus or community — no one has to leave the premises."],
  ["Trained staff", "FabricFold hires and manages the counter staff. You don't take on any laundry payroll or supervision."],
  ["Garment tagging & the app", "Every item is QR-tagged and every order tracked in the FabricFold app your students and residents already use."],
  ["Transparent records", "You get a real vendor with digital records of every order, payment and GST invoice — not an untraceable cash arrangement."],
];

const PARTNER_STEPS = [
  ["Get in touch", "Message us with your campus or community details — number of students or residents, and what laundry looks like today."],
  ["We assess the site", "We visit, understand the space and demand, and design a counter setup and staffing plan that fits."],
  ["We set it up", "Counter, staff, tagging, signage and the app — we handle the rollout and onboard your community."],
  ["Go live", "Students and residents start booking from day one. You get a single point of contact for anything you need."],
];

export default function Partners() {
  return (
    <MarketingShell active="/partners">
      <header className="mx m-hero">
        <div>
          <span className="m-kicker">For colleges, hostels &amp; communities</span>
          <h1 className="m-h1">Give your campus laundry that <em>just works</em></h1>
          <p className="m-lead">
            Laundry is one of the most common complaints in any hostel or community — and one of the hardest to run well.
            FabricFold takes it off your plate entirely. We set up and run the whole operation on-site, and you get a
            reliable service with records you can actually trust.
          </p>
          <div className="m-cta">
            <a href={WHATSAPP} target="_blank" rel="noreferrer" className="btn">Partner with us</a>
            <a href="mailto:support@fabricfold.in?subject=FabricFold%20for%20our%20campus" className="btn ghost">Email us</a>
          </div>
        </div>
        <div className="m-phone" aria-hidden="true">
          <div className="bar" />
          <div className="card pad">
            <div className="label">This month · your campus</div>
            <div className="kv mt8"><span className="k">Orders handled</span><span className="mono">318</span></div>
            <div className="kv"><span className="k">On-time collection</span><span className="mono">97%</span></div>
            <div className="kv"><span className="k">Avg. rating</span><span className="mono">4.6 ★</span></div>
          </div>
          <div className="card pad mt12">
            <div className="row gap8"><span className="dot" /><span style={{ fontSize: 13 }}>Every order on record, GST-ready</span></div>
          </div>
        </div>
      </header>

      <section className="m-sec alt">
        <div className="mx">
          <h2 className="m-h2 center">What we set up and run for you</h2>
          <p className="m-sub">You provide the space. We do the rest.</p>
          <div className="m-grid c4">
            {SETUP.map(([h, p]) => (
              <div className="m-card" key={h}><h3>{h}</h3><p>{p}</p></div>
            ))}
          </div>
        </div>
      </section>

      <section className="m-sec">
        <div className="mx">
          <div className="m-split">
            <div>
              <h2 className="m-h2">Why institutions choose FabricFold</h2>
              <ul className="m-check">
                <li>Zero admin overhead — no laundry staff, rosters or complaints to manage yourself</li>
                <li>Happier students and residents, with fewer laundry grievances reaching your office</li>
                <li>Transparent digital records of every order, payment and invoice</li>
                <li>Accountability built in — garment tagging, compensation policy and free re-dos</li>
                <li>A single point of contact for anything you need</li>
              </ul>
            </div>
            <div className="m-split-media">
              <div className="m-panel">
                <div className="stat">Custom pricing</div>
                <p style={{ fontSize: 15, color: "var(--ink-2)", lineHeight: 1.6, marginTop: 8 }}>
                  Every campus and community is different — size, demand and space all vary. We tailor the setup and
                  pricing to your site rather than forcing a one-size-fits-all rate. Tell us about your place and we&apos;ll
                  put together a plan.
                </p>
                <a href={WHATSAPP} target="_blank" rel="noreferrer" className="btn mt16" style={{ width: "auto", padding: "0 22px" }}>Request a plan</a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="m-sec alt">
        <div className="mx">
          <h2 className="m-h2 center">How partnering works</h2>
          <div className="mx mkt-narrow" style={{ padding: 0 }}>
            <div className="m-steps">
              {PARTNER_STEPS.map(([h, p], i) => (
                <div className="m-step" key={i}><div className="num">{i + 1}</div><div><h3>{h}</h3><p>{p}</p></div></div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="m-sec">
        <div className="mx">
          <div className="m-band">
            <h2>Let&apos;s bring FabricFold to your campus</h2>
            <p>Tell us about your college, hostel or community and we&apos;ll take it from there. Setup is quick, and there&apos;s no cost to have a conversation.</p>
            <a href={WHATSAPP} target="_blank" rel="noreferrer" className="btn">Start on WhatsApp</a>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
