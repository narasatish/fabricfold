"use client";
import { useEffect, useRef, useState } from "react";
import { Qr } from "@/components/qr";
import { Svg } from "@/components/icons";
import { createScanCode } from "@/lib/actions/students";

/* Shown at the counter — both for dropping off laundry (staff scans it,
   lands on this student's account, creates the order there) and for
   picking it up later (same screen, scanned again once the order shows
   "ready"). Instead of asking for and typing an ID, staff just scans.

   The code is a fresh, one-time token fetched from the server each time
   this sheet opens (lib/actions/students.ts, createScanCode) — never the
   student's own id. Owner (2026-11): a QR that stayed the same forever
   could be screenshotted and reused, so every scan must be a different,
   single-use code that expires on its own in 10 minutes. */
export default function MyQr() {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [secsLeft, setSecsLeft] = useState(0);
  const refreshing = useRef(false);

  const refresh = async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const r = await createScanCode();
      if (r.ok) {
        setUrl(`${window.location.origin}/s/scan/${r.token}`);
        setExpiresAt(r.expiresAt);
      }
    } finally {
      refreshing.current = false;
    }
  };

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open]);

  useEffect(() => {
    if (!open || !expiresAt) return;
    const tick = () => {
      const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
      setSecsLeft(left);
      if (left === 0) void refresh(); // auto-replace an expired code so the counter is never stuck on a dead one
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [open, expiresAt]);

  return (
    <>
      <button className="list-item tap" style={{ width: "100%", textAlign: "left" }} onClick={() => setOpen(true)}>
        <span style={{ color: "var(--teal)" }}>
          <Svg name="camera" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="h-sm">Show my QR code</div>
          <div className="muted" style={{ fontSize: "12px" }}>
            For drop-off and pickup at the counter
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
            <div className="muted mt4" style={{ fontSize: "12px" }}>
              Dropping off or picking up — either way, just show this
            </div>
            <div className="mt16" style={{ display: "flex", justifyContent: "center" }}>
              {url ? <Qr text={url} size={220} /> : <div style={{ width: 220, height: 220 }} />}
            </div>
            <div className="muted mt8" style={{ fontSize: "12px" }}>
              {url ? `New code in ${secsLeft}s` : "Loading…"}
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
