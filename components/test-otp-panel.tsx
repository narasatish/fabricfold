"use client";
/* TEST-ONLY: realtime viewer for pending OTP codes, so any phone number can be
   tested before SMS delivery is live. Owner-only + TEST_TOOLS-gated server-side.
   Polls every 3s. Remove with the rest of the test tooling before launch. */
import { useEffect, useState } from "react";
import { peekOtps } from "@/lib/actions/testing";

type Otp = { phone: string; code: string; purpose: string; expiresInSec: number };

export function TestOtpPanel() {
  const [otps, setOtps] = useState<Otp[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const r = await peekOtps();
      if (!alive) return;
      if (r.ok) { setOtps(r.otps); setErr(null); }
      else setErr(r.error);
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  if (err) return null; // test tools off / not owner — render nothing

  return (
    <>
      <div className="between mt16" style={{ padding: "0 4px" }}>
        <span className="sec-title" style={{ padding: 0, color: "var(--amber)" }}>🔑 Test OTPs (live)</span>
        <span className="pill gray" style={{ fontSize: 10.5 }}>auto-refresh · remove at launch</span>
      </div>
      <div className="card pad">
        {otps.length === 0 ? (
          <div className="muted center" style={{ fontSize: 12.5, padding: "8px 0" }}>
            No pending codes. Request an OTP on the login screen and it appears here within 3s.
          </div>
        ) : (
          otps.map((o, i) => (
            <div key={i} className="kv">
              <span className="k" style={{ fontSize: 13 }}>
                +91 {o.phone} <span className="muted" style={{ fontSize: 11 }}>· {o.purpose} · {o.expiresInSec}s left</span>
              </span>
              <span className="mono" style={{ fontWeight: 700, letterSpacing: ".08em", fontSize: 16 }}>{o.code}</span>
            </div>
          ))
        )}
      </div>
    </>
  );
}
