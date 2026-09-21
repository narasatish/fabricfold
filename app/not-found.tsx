import Link from "next/link";

/* The 404 screen. Without this file Next shows its bare default
   ("404 | This page could not be found.") with no branding and no way back —
   a dead end for a student who mistypes a link or opens an old one. */
export const metadata = { title: "Page not found — FabricFold" };

export default function NotFound() {
  return (
    <div className="screen no-nav">
      <div className="empty" style={{ paddingTop: "18vh" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo-full-264.png" alt="FabricFold" width={96} height={96} style={{ borderRadius: 18 }} />
        <div className="h-md mt16">We couldn&apos;t find that page</div>
        <div className="muted mt4" style={{ fontSize: 13.5, maxWidth: 280, margin: "6px auto 0" }}>
          The link may be old or mistyped. Head back to FabricFold, or sign in to see your orders.
        </div>
        <Link href="/" className="btn mt20" style={{ width: "auto", padding: "0 26px", display: "inline-flex" }}>Go to FabricFold</Link>
        <div className="mt12">
          <Link href="/login" className="muted" style={{ fontSize: 13.5, textDecoration: "underline" }}>Sign in</Link>
        </div>
      </div>
    </div>
  );
}
