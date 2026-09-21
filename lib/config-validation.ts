/* Validation for admin-typed business config. Each returns null when fine, or a
   short message for the person to fix. Bounds mirror the Sheet Config tab's own
   (GST 0-28, price > 0 up to 100000) so the two ways of editing agree. */

const MAX_PRICE = 100_000;
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export function ratesProblem(rates: unknown): string | null {
  if (!rates || typeof rates !== "object" || Array.isArray(rates)) return "Rates are missing";
  for (const [svc, r] of Object.entries(rates as Record<string, unknown>)) {
    const rr = r as { label?: unknown; items?: unknown };
    if (typeof rr?.label !== "string" || rr.label.length > 60) return `${svc}: the service name is missing or too long`;
    if (!Array.isArray(rr.items) || rr.items.length > 60) return `${svc}: the item list is invalid`;
    for (const it of rr.items) {
      if (!Array.isArray(it) || typeof it[0] !== "string" || !it[0].trim() || it[0].length > 80) return `${svc}: every item needs a name (up to 80 characters)`;
      if (!num(it[1]) || it[1] <= 0 || it[1] > MAX_PRICE) return `${svc} · ${String(it[0]).slice(0, 30)}: price must be above 0 and at most ${MAX_PRICE}`;
    }
  }
  return null;
}

export function expressProblem(fees: unknown): string | null {
  if (!fees || typeof fees !== "object" || Array.isArray(fees)) return "Express fees are missing";
  for (const [svc, v] of Object.entries(fees as Record<string, unknown>)) {
    if (!num(v) || v < 0 || v > 10_000) return `${svc}: the express fee must be between 0 and 10000`;
  }
  return null;
}

export function gstProblem(gst: unknown): string | null {
  return num(gst) && gst >= 0 && gst <= 28 ? null : "GST must be between 0 and 28";
}

/** UPI ID (VPA) shape: handle@provider, no spaces/URLs. The pay QR is built from it. Empty = not set yet. */
const UPI_RE = /^[a-zA-Z0-9._-]{2,64}@[a-zA-Z][a-zA-Z0-9.-]{1,63}$/;
const IFSC_RE = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/;

export const PAYMENT_KEYS = ["upiId", "payeeName", "bankName", "accountName", "accountNo", "ifsc", "gatewayKey"] as const;

export function paymentProblem(p: Record<string, unknown>): string | null {
  // A field the form never sent (production starts with an empty payment
  // object) counts as blank, so the very first save with just a UPI ID works.
  const s = (k: string) => (p?.[k] == null ? "" : typeof p[k] === "string" ? (p[k] as string).trim() : null);
  for (const k of PAYMENT_KEYS) {
    const v = s(k);
    if (v === null) return "A payment detail is not text";
    if (v.length > 120) return "A payment detail is too long";
  }
  if (s("upiId") && !UPI_RE.test(s("upiId") as string)) return "That UPI ID doesn't look right — it should look like name@bank";
  if (s("ifsc") && !IFSC_RE.test(s("ifsc") as string)) return "That IFSC code doesn't look right (11 characters, e.g. CBIN0281234)";
  if (s("accountNo") && !/^\d{6,20}$/.test(s("accountNo") as string)) return "The account number should be 6–20 digits";
  return null;
}

export function emailProblem(e: unknown): string | null {
  if (e === "" || e == null) return null;
  return typeof e === "string" && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? null : "That email address doesn't look right";
}
