"use client";
/* Printable BVRIT registration poster — open, Ctrl+P, stick it on campus
   noticeboards. Distinct from /get/poster (which points existing students at
   sign-in): BVRIT students don't have an account yet, so this QR has to land
   on /join/bvrit — the self-register-via-WhatsApp flow — not /get, which
   would just tell them to "visit the counter first" (St Mary's model, not
   BVRIT's). Same reasoning as that poster: a page, not a PNG, so reprinting
   always encodes whatever this page says today. */
import { Qr } from "@/components/qr";

export default function BvritRegisterPoster() {
  return (
    <div style={{ minHeight: "100vh", background: "#fff", color: "#111", display: "grid", placeItems: "center", padding: 24 }}>
      <style>{`@media print { .no-print { display: none } }`}</style>
      <div style={{ textAlign: "center", maxWidth: 640 }}>
        <div style={{ fontSize: 52, fontWeight: 800, color: "#0e9271" }}>FabricFold</div>
        <div style={{ fontSize: 22, marginTop: 4 }}>BVRIT campus laundry &amp; dry-cleaning</div>

        <div style={{ margin: "36px auto", width: "fit-content", padding: 20, border: "3px solid #0e9271", borderRadius: 24 }}>
          <Qr text="https://fabricfold.in/join/bvrit" size={340} />
        </div>

        <div style={{ fontSize: 30, fontWeight: 700 }}>Scan to register</div>
        <div style={{ fontSize: 18, marginTop: 10, lineHeight: 1.6, color: "#444" }}>
          New here? Scan, enter your name, verify your number on WhatsApp — you&apos;re in.
          No counter visit needed.
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, marginTop: 22, letterSpacing: ".02em" }}>fabricfold.in/join/bvrit</div>

        <button className="no-print" onClick={() => window.print()}
          style={{ marginTop: 32, padding: "12px 28px", fontSize: 16, borderRadius: 12, border: "1px solid #0e9271", background: "#0e9271", color: "#fff", cursor: "pointer" }}>
          Print this poster
        </button>
      </div>
    </div>
  );
}
