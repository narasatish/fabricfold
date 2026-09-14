"use client";
/* QR rendering, via the `qrcode` package (Sep 2026).

   Replaced a hand-rolled encoder that had been silently producing
   unscannable codes for EVERY input, including trivial ones like "hello" —
   found when the owner reported the printed BVRIT registration QR wasn't
   taking students anywhere. It wasn't a content bug (wrong URL, stale
   link): every QR this component ever rendered — registration posters, UPI
   payment codes in both the customer and staff apps, garment-tag codes —
   was structurally broken and would never have scanned. `qrcode` is a
   widely-used, tested implementation; component API (text/size/dark/light)
   is unchanged so no caller needs to change. */
import { useEffect, useRef } from "react";
import QRCode from "qrcode";

export function Qr({ text, size = 120, dark = "#12211c", light = "#fff" }: { text: string; size?: number; dark?: string; light?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    QRCode.toCanvas(cv, text, {
      width: size,
      margin: 2,
      color: { dark, light },
      errorCorrectionLevel: "M",
    }).catch((e) => console.error("[qr] render failed:", e));
  }, [text, size, dark, light]);
  return <canvas ref={ref} style={{ width: size, height: size, borderRadius: 8 }} />;
}
