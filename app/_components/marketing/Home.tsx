import Link from "next/link";
import MarketingShell, { WHATSAPP } from "./Shell";

/* tiny inline icons (self-contained, on-brand stroke) */
const I = {
  tag: "M20.59 13.41 12 22l-9-9V3h10l7.59 7.59a2 2 0 0 1 0 2.82ZM7 7h.01",
  track: "M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-5.07-2.83 2.83M9.76 14.24l-2.83 2.83m0-10.14 2.83 2.83m4.48 4.48 2.83 2.83",
  file: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 15h6",
  gift: "M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7ZM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7Z",
  card: "M2 5h20v14H2zM2 10h20",
  chat: "M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-4-1L3 21l1.9-5.5a8.5 8.5 0 0 1 3.6-11.5 8.38 8.38 0 0 1 9 1.5 8.38 8.38 0 0 1 2.5 6Z",
};
function Ic({ d }: { d: string }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">{d.split("M").filter(Boolean).map((seg, i) => <path key={i} d={"M" + seg} />)}</svg>;
}

export default function Home() {
  return (
    <MarketingShell>
      {/* Hero */}
      <header className="mx m-hero">
        <div>
          <span className="m-kicker">Campus &amp; community laundry, done right</span>
          <h1 className="m-h1">Laundry, handled for your <em>whole campus</em></h1>
          <p className="m-lead">
            We run the laundry counter on your campus or community — students and residents book from their phone,
            drop their clothes, and collect them washed, ironed and folded. Every garment is tagged and tracked,
            so nothing goes missing and no one waits around wondering when it&apos;s done.
          </p>
          <div className="m-cta">
            <Link href="/login" className="btn">Open the app</Link>
            <Link href="/partners" className="btn ghost">Bring us to your campus</Link>
          </div>
          <div className="m-proof">
            <div><b>48 hrs</b><span>standard turnaround</span></div>
            <div><b>Every piece</b><span>QR-tagged &amp; tracked</span></div>
            <div><b>Live</b><span>status on your phone</span></div>
          </div>
        </div>

        <div className="m-phone" aria-hidden="true">
          <div className="bar" />
          <div className="card pad">
            <div className="between">
              <span className="h-sm">Your order</span>
              <span className="pill st-ready">Ready</span>
            </div>
            <div className="kv mt8"><span className="k">Wash &amp; Iron · 12 pieces</span></div>
            <div className="kv"><span className="k">All garments tagged</span><span className="mono">12 / 12</span></div>
          </div>
          <div className="card pad mt12 center">
            <div className="label">Pickup code</div>
            <div className="otp-box">4821</div>
          </div>
          <div className="card pad mt12">
            <div className="row gap8"><span className="dot" /><span style={{ fontSize: 13 }}>Your laundry is ready for collection</span></div>
          </div>
        </div>
      </header>

      {/* Who we serve */}
      <section className="m-sec alt tight">
        <div className="mx">
          <h2 className="m-h2 center">Built for places where people live together</h2>
          <p className="m-sub">Wherever there&apos;s a crowd and not enough time for laundry, we set up and run it.</p>
          <div className="m-serve">
            <div className="chip"><span>●</span> Colleges &amp; universities</div>
            <div className="chip"><span>●</span> Hostels</div>
            <div className="chip"><span>●</span> Residential communities</div>
            <div className="chip"><span>●</span> Co-living &amp; PGs</div>
            <div className="chip"><span>●</span> Corporate campuses</div>
          </div>
        </div>
      </section>

      {/* How it works (brief) */}
      <section className="m-sec">
        <div className="mx">
          <h2 className="m-h2 center">Three steps, no waiting around</h2>
          <p className="m-sub">Book from your room, drop between classes, collect when it&apos;s ready.</p>
          <div className="m-grid c3">
            <div className="m-card"><div className="n">1</div><h3>Book on your phone</h3><p>Pick a service and count your pieces. You get an order ID to show at the counter.</p></div>
            <div className="m-card"><div className="n">2</div><h3>Drop at the counter</h3><p>Our staff check the count with you and tag every garment with its own QR code.</p></div>
            <div className="m-card"><div className="n">3</div><h3>Collect with a code</h3><p>You get a notification and a pickup code the moment your laundry is ready.</p></div>
          </div>
          <div className="m-cta center"><Link href="/how-it-works" className="btn ghost">See how it works in detail</Link></div>
        </div>
      </section>

      {/* Why FabricFold */}
      <section className="m-sec alt">
        <div className="mx">
          <h2 className="m-h2 center">The details that make it actually work</h2>
          <div className="m-grid c3">
            <div className="m-card"><div className="ic"><Ic d={I.tag} /></div><h3>A tag on every garment</h3><p>Each piece gets a scannable QR tag at drop-off, so ten orders of white shirts never turn into one confusing pile.</p></div>
            <div className="m-card"><div className="ic"><Ic d={I.track} /></div><h3>Live order tracking</h3><p>Received, processing, ready — the status updates on the student&apos;s phone in real time, with an alert when it&apos;s done.</p></div>
            <div className="m-card"><div className="ic"><Ic d={I.file} /></div><h3>Proper digital records</h3><p>Every order, payment and GST invoice is recorded. Colleges get a vendor with a clean paper trail, not a cash box.</p></div>
            <div className="m-card"><div className="ic"><Ic d={I.gift} /></div><h3>Compensation &amp; free re-dos</h3><p>Damaged or unsatisfactory? We compensate as store credit and re-clean at no charge. Fair, and on record.</p></div>
            <div className="m-card"><div className="ic"><Ic d={I.card} /></div><h3>Pay how you like</h3><p>UPI, cash at the counter, or store credit. UPI payments come with a downloadable GST invoice.</p></div>
            <div className="m-card"><div className="ic"><Ic d={I.chat} /></div><h3>Complaints that get answered</h3><p>Raise an issue in the app and chat directly with staff until it&apos;s sorted — every complaint tracked to resolution.</p></div>
          </div>
        </div>
      </section>

      {/* Partner CTA */}
      <section className="m-sec">
        <div className="mx">
          <div className="m-band">
            <h2>Run a college, hostel or community?</h2>
            <p>We set up the counter, staff, garment tagging and the app. Your people get reliable, tracked laundry and you get a vendor with real records. Pricing is tailored to each site.</p>
            <a href={WHATSAPP} target="_blank" rel="noreferrer" className="btn">Talk to us on WhatsApp</a>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
