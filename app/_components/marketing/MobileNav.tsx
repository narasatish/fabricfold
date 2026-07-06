"use client";
import { useState } from "react";
import Link from "next/link";

const NAV = [
  { href: "/how-it-works", label: "How it works" },
  { href: "/partners", label: "For colleges & communities" },
  { href: "/about", label: "About" },
  { href: "/contact", label: "Contact" },
];

/* Mobile-only hamburger menu (hidden on desktop via CSS). */
export default function MobileNav({ active }: { active?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="m-mobile">
      <button className="m-burger" aria-label="Menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          {open ? <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></> : <><path d="M3 6h18" /><path d="M3 12h18" /><path d="M3 18h18" /></>}
        </svg>
      </button>
      {open && (
        <>
          <div className="m-mobile-scrim" onClick={() => setOpen(false)} />
          <div className="m-mobile-panel">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className={active === n.href ? "on" : ""} onClick={() => setOpen(false)}>{n.label}</Link>
            ))}
            <Link href="/login" className="btn" onClick={() => setOpen(false)} style={{ marginTop: 8 }}>Open the app</Link>
          </div>
        </>
      )}
    </div>
  );
}
