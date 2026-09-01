"use client";
/* Printable install poster — open, Ctrl+P, stick it on the counter.

   A page rather than a PNG on purpose: it uses the same QR generator the app
   already trusts, needs no design tool to reprint, and if /get ever moves the
   poster can't be an out-of-date image in a drawer — reprinting always
   encodes whatever this page says today. */
import { Qr } from "@/components/qr";

export default function InstallPoster() {
  return (
    <div style={{ minHeight: "100vh", background: "#fff", color: "#111", display: "grid", placeItems: "center", padding: 24 }}>
      <style>{`@media print { .no-print { display: none } }`}</style>
      <div style={{ textAlign: "center", maxWidth: 640 }}>
        <div style={{ fontSize: 52, fontWeight: 800, color: "#0e9271" }}>FabricFold</div>
        <div style={{ fontSize: 22, marginTop: 4 }}>Campus laundry &amp; dry-cleaning</div>

        <div style={{ margin: "36px auto", width: "fit-content", padding: 20, border: "3px solid #0e9271", borderRadius: 24 }}>
          <Qr text="https://fabricfold.in/get" size={340} />
        </div>

        <div style={{ fontSize: 30, fontWeight: 700 }}>Scan to get the app</div>
        <div style={{ fontSize: 18, marginTop: 10, lineHeight: 1.6, color: "#444" }}>
          Track your laundry · know when it&apos;s ready · sign in with one WhatsApp message
        </div>
        <div style={{ fontSize: 22, fontWeight: 700, marginTop: 22, letterSpacing: ".02em" }}>fabricfold.in/get</div>

        <button className="no-print" onClick={() => window.print()}
          style={{ marginTop: 32, padding: "12px 28px", fontSize: 16, borderRadius: 12, border: "1px solid #0e9271", background: "#0e9271", color: "#fff", cursor: "pointer" }}>
          Print this poster
        </button>
      </div>
    </div>
  );
}
