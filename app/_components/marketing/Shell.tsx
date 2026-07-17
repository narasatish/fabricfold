import Link from "next/link";
import MobileNav from "./MobileNav";
import "../../landing.css";

const NAV = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/partners", label: "For colleges & communities" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

const WHATSAPP = "https://wa.me/918019121966";

/* Shared marketing chrome: sticky nav + footer. `active` highlights the current page. */
export default function MarketingShell({ active, children }: { active?: string; children: React.ReactNode }) {
  return (
    <div className="mkt">
      <nav className="m-nav">
        <div className="mx">
          <Link href="/" className="m-logo"><span className="mark">F</span> FabricFold</Link>
          <div className="m-links">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className={active === n.href ? "on" : ""}>{n.label}</Link>
            ))}
          </div>
          <Link href="/login" className="btn sm m-nav-cta">Open the app</Link>
          <MobileNav active={active} />
        </div>
      </nav>

      {children}

      <footer className="m-foot">
        <div className="mx">
          <div className="cols">
            <div>
              <div className="brand"><span className="mark">F</span> FabricFold</div>
              <p className="tag">Campus &amp; community laundry, run on-site and managed from your phone. Now serving colleges and communities across Telangana.</p>
            </div>
            <div>
              <h4>Company</h4>
              <Link href="/how-it-works">How it works</Link>
              <Link href="/partners">For colleges &amp; communities</Link>
              <Link href="/about">About us</Link>
              <Link href="/contact">Contact</Link>
            </div>
            <div>
              <h4>Legal</h4>
              <Link href="/terms">Terms &amp; conditions</Link>
              <Link href="/refunds">Refunds &amp; compensation</Link>
              <Link href="/privacy">Privacy policy</Link>
            </div>
            <div>
              <h4>Get in touch</h4>
              <a href={WHATSAPP} target="_blank" rel="noreferrer">WhatsApp +91 80191 21966</a>
              <a href="mailto:support@fabricfold.in">support@fabricfold.in</a>
              <Link href="/login">Student &amp; staff login</Link>
            </div>
          </div>
          <div className="base">
            <span>© 2026 FabricFold · Telangana, India</span>
            <span>Book · Track · Collect</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export { WHATSAPP };
