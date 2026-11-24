"use client";
import { useState } from "react";
import { Qr } from "@/components/qr";
import { Svg } from "@/components/icons";

/* Shown at the counter so staff can scan straight to this student's order
   page instead of asking for and typing their ID — the exact bottleneck
   the owner described (staff manually searching by ID/phone every visit).
   Encodes a URL (not a bare id) so scanning with ANY camera app, not just
   the staff scanner, still does something sane: opens the link, which
   redirects through the staff auth + same-college gate at /s/scan/[id]. */
export default function MyQr({ studentId }: { studentId: string }) {
  const [open, setOpen] = useState(false);
  const url = typeof window !== "undefined" ? `${window.location.origin}/s/scan/${studentId}` : `/s/scan/${studentId}`;

  return (
    <>
      <button className="list-item tap" style={{ width: "100%", textAlign: "left" }} onClick={() => setOpen(true)}>
        <span style={{ color: "var(--teal)" }}>
          <Svg name="camera" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="h-sm">Show my QR code</div>
          <div className="muted" style={{ fontSize: "12px" }}>
            Let staff scan this at the counter
          </div>
        </div>
        <Svg name="chevR" size={18} />
      </button>

      {open && (
        <div
          className="sheet-backdrop"
          onClick={() => setOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}
        >
          <div className="card pad" style={{ background: "#fff", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
            <div className="h-md">Show this at the counter</div>
            <div className="mt16" style={{ display: "flex", justifyContent: "center" }}>
              <Qr text={url} size={220} />
            </div>
            <button className="btn sec mt16" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
        </div>
      )}
    </>
  );
}
