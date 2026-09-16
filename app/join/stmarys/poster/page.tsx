"use client";
/* Printable St Mary's sign-in poster — open, Ctrl+P, stick it on campus
   noticeboards. Distinct from /join/bvrit/poster: St Mary's has no
   self-registration (counter-only, see lib/actions/admin.ts registerStudent),
   so this QR lands on /join/stmarys — sign-in only, for returning students,
   faculty, and staff — with a clear note to visit the counter first if new.
   A page, not a PNG, so reprinting always encodes whatever this page says
   today. */
import { Qr } from "@/components/qr";

export default function StMarysSignInPoster() {
  return (
    <div style={{ minHeight: "100vh", background: "#fff", color: "#111", display: "grid", placeItems: "center", padding: 24 }}>
      <style>{`@media print { .no-print { display: none } }`}</style>
      <div style={{ textAlign: "center", maxWidth: 640 }}>
        <div style={{ fontSize: 52, fontWeight: 800, color: "#0e9271" }}>FabricFold</div>
        <div style={{ fontSize: 22, marginTop: 4 }}>St Mary&apos;s campus laundry &amp; dry-cleaning</div>

        <div style={{ margin: "36px auto", width: "fit-content", padding: 20, border: "3px solid #0e9271", borderRadius: 24 }}>
          <Qr text="https://fabricfold.in/join/stmarys" size={340} />
        </div>

        <div style={{ fontSize: 30, fontWeight: 700 }}>Scan to sign in</div>
        <div style={{ fontSize: 18, marginTop: 10, lineHeight: 1.6, color: "#444" }}>
          Already registered? Scan and verify your number on WhatsApp — you&apos;re in.
          New here? Visit the counter first — it takes a minute.
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, marginTop: 22, letterSpacing: ".02em" }}>fabricfold.in/join/stmarys</div>

        <button className="no-print" onClick={() => window.print()}
          style={{ marginTop: 32, padding: "12px 28px", fontSize: 16, borderRadius: 12, border: "1px solid #0e9271", background: "#0e9271", color: "#fff", cursor: "pointer" }}>
          Print this poster
        </button>
      </div>
    </div>
  );
}
