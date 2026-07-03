import Link from "next/link";
import "../landing.css";

/* Marketing landing at "/" — server-rendered, guests only (signed-in users
   are redirected to their app in app/page.tsx). */
export default function Landing() {
  return (
    <div className="landing">
      {/* Nav */}
      <nav className="l-nav">
        <div className="lx">
          <div className="l-logo">FabricFold</div>
          <div className="l-links">
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#faq">FAQ</a>
            <a href="#campus">For campuses</a>
          </div>
          <Link href="/login" className="btn sm">Open the app</Link>
        </div>
      </nav>

      {/* Hero */}
      <header className="lx l-hero">
        <div>
          <span className="l-kicker">Now at BVRIT &amp; St Mary&apos;s</span>
          <h1 className="l-h1">Laundry day, <em>off your timetable</em></h1>
          <p className="l-sub">
            Drop your clothes at the campus counter, track every piece from wash to fold on your
            phone, and collect with a one-time code when it&apos;s ready. Wash &amp; iron from ₹15 a
            piece — no minimums, no guessing when it&apos;s done.
          </p>
          <div className="l-cta-row">
            <Link href="/login" className="btn">Get started — it&apos;s free to join</Link>
            <a href="#pricing" className="btn ghost">See pricing</a>
          </div>
          <div className="l-proof">
            <div><b>₹15</b><span>per piece, wash &amp; iron</span></div>
            <div><b>48 hrs</b><span>standard turnaround</span></div>
            <div><b>24 hrs</b><span>express service</span></div>
          </div>
        </div>

        {/* stylised phone preview */}
        <div className="l-phone" aria-hidden="true">
          <div className="bar" />
          <div className="card pad">
            <div className="between">
              <span className="h-sm">Order #7605</span>
              <span className="pill st-ready">Ready</span>
            </div>
            <div className="kv mt8"><span className="k">Regular garment ×10</span><span className="mono">₹150</span></div>
            <div className="kv total"><span>Total</span><span className="mono">₹150</span></div>
          </div>
          <div className="card pad mt12 center">
            <div className="label">Pickup code</div>
            <div className="otp-box">3621</div>
          </div>
          <div className="card pad mt12">
            <div className="row gap8"><span className="dot" /><span style={{ fontSize: 13 }}>Your order is ready for collection</span></div>
          </div>
        </div>
      </header>

      {/* How it works */}
      <section className="l-sec alt" id="how">
        <div className="lx">
          <h2 className="l-sec-title">Three steps, zero waiting around</h2>
          <p className="l-sec-sub">Built for hostel life — book from your room, drop between classes.</p>
          <div className="l-grid3">
            <div className="l-step">
              <div className="n">1</div>
              <h3>Pre-book from your phone</h3>
              <p>Pick a service, count your pieces and get an order ID. Prices are fixed per item, so you know the bill before you leave your room.</p>
            </div>
            <div className="l-step">
              <div className="n">2</div>
              <h3>Drop at the counter</h3>
              <p>Staff verify the count with you and tag every garment with its own QR code — so nothing gets mixed up or lost in the wash.</p>
            </div>
            <div className="l-step">
              <div className="n">3</div>
              <h3>Collect with your code</h3>
              <p>You get a notification and a 4-digit pickup code the moment your order is ready. Show the code, grab your clothes, done.</p>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="l-sec" id="pricing">
        <div className="lx">
          <h2 className="l-sec-title">Honest per-piece pricing</h2>
          <p className="l-sec-sub">Pay per order, or subscribe and stop thinking about it. GST as applicable.</p>
          <div className="l-grid3">
            <div className="l-price">
              <span className="tag">Wash &amp; Iron</span>
              <div className="amt">₹15 <small>/ piece</small></div>
              <ul>
                <li>Regular garments ₹15, bedsheets ₹25</li>
                <li>Washed, dried, pressed &amp; folded</li>
                <li>Ready in 48 hours</li>
                <li>Express same-day for ₹100 flat</li>
              </ul>
              <Link href="/login" className="btn ghost">Book a wash</Link>
            </div>
            <div className="l-price hot">
              <span className="tag">Annual plan</span>
              <div className="amt">₹8,024 <small>/ year, incl. GST</small></div>
              <ul>
                <li>34 wash cycles — roughly one a week for two semesters</li>
                <li>Up to 7 kg per cycle (a full week&apos;s load)</li>
                <li>Skip payment at the counter, just drop &amp; go</li>
                <li>Works out cheaper than per-piece for regulars</li>
              </ul>
              <Link href="/login" className="btn">Subscribe</Link>
            </div>
            <div className="l-price">
              <span className="tag">Iron &amp; Dry clean</span>
              <div className="amt">₹10 <small>onwards</small></div>
              <ul>
                <li>Ironing from ₹10 a piece, sarees ₹30</li>
                <li>Dry cleaning from ₹60 (dupattas) to ₹350 (shoes)</li>
                <li>Shirts, trousers &amp; tees dry-cleaned at ₹100</li>
                <li>Same tracking and pickup codes</li>
              </ul>
              <Link href="/login" className="btn ghost">See full rate card</Link>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="l-sec alt">
        <div className="lx">
          <h2 className="l-sec-title">The boring stuff, handled properly</h2>
          <div className="l-grid3">
            <div className="l-step"><h3>Live order tracking</h3><p>Received, processing, ready — your phone updates in real time at every step, with push notifications when it matters.</p></div>
            <div className="l-step"><h3>QR tag on every garment</h3><p>Each piece gets its own scannable tag at drop-off. That&apos;s how we keep 10 orders of white shirts from becoming one big pile.</p></div>
            <div className="l-step"><h3>Pay how you like</h3><p>UPI at the counter, cash, or store credits. UPI payments come with a proper GST invoice you can download anytime.</p></div>
            <div className="l-step"><h3>Store credits &amp; refunds</h3><p>Damaged button? Late order? Compensation lands as credits you can spend on the next wash — or take a straight refund.</p></div>
            <div className="l-step"><h3>Free re-dos</h3><p>Not happy with the press or a stain that survived? We run it again at no charge. No forms, just tell the counter.</p></div>
            <div className="l-step"><h3>Complaints that get answered</h3><p>Raise an issue in the app and chat directly with staff until it&apos;s resolved. Every complaint has a paper trail.</p></div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="l-sec" id="faq">
        <div className="lx">
          <h2 className="l-sec-title">Questions students actually ask</h2>
          <div className="l-faq">
            <details>
              <summary>How do I sign up?</summary>
              <p>With your phone number — you&apos;ll get an OTP, pick your campus, and you&apos;re in. No email, no password, no app store download (it works in your browser and can be installed like an app).</p>
            </details>
            <details>
              <summary>What if a garment is damaged or goes missing?</summary>
              <p>Every piece is QR-tagged at drop-off, so missing items are rare. If something is damaged or lost, staff issue compensation as store credits or cash after checking the order — the policy is in the app under Terms.</p>
            </details>
            <details>
              <summary>How does the subscription work?</summary>
              <p>₹8,024 a year (GST included) gets you 34 cycles of up to 7 kg each — about one full load a week across both semesters. One drop-off uses one cycle. If a load runs over 7 kg, only the extra kilos are charged.</p>
            </details>
            <details>
              <summary>When is express worth it?</summary>
              <p>Standard orders come back in 48 hours. Express is a flat ₹100 on top of your bill and comes back the same day — handy before fests, interviews and surprise inspections.</p>
            </details>
            <details>
              <summary>My campus isn&apos;t listed. Can you come?</summary>
              <p>We&apos;re expanding one campus at a time. Message us on WhatsApp and tell us your college — student demand is literally how we pick the next one.</p>
            </details>
          </div>
        </div>
      </section>

      {/* Campus CTA */}
      <section className="l-sec alt" id="campus">
        <div className="lx center">
          <h2 className="l-sec-title">Run a hostel or campus?</h2>
          <p className="l-sec-sub" style={{ maxWidth: 560, margin: "10px auto 0" }}>
            We set up the counter, staff, tagging and the app — your students get tracked, priced-upfront
            laundry and you get a vendor with real records. Talk to us about bringing FabricFold to your campus.
          </p>
          <div className="l-cta-row" style={{ justifyContent: "center", marginTop: 24 }}>
            <a href="https://wa.me/918019121966" target="_blank" rel="noreferrer" className="btn" style={{ width: "auto" }}>WhatsApp us</a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="l-foot">
        <div className="lx">
          <div>
            <div style={{ fontWeight: 750, color: "#fff", fontSize: 16 }}>FabricFold</div>
            <div style={{ marginTop: 6 }}>Campus laundry &amp; dry-cleaning · Telangana, India</div>
          </div>
          <div>
            <a href="https://wa.me/918019121966" target="_blank" rel="noreferrer">WhatsApp +91 80191 21966</a>
            <span style={{ margin: "0 10px", opacity: .4 }}>·</span>
            <Link href="/login">Sign in</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
