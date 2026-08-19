/* Formatting helpers — same output as the prototype. */
export const fmt = (n: number | unknown) => "₹" + Number(n || 0).toLocaleString("en-IN");

export function timeAgo(t: Date | number) {
  const ts = typeof t === "number" ? t : t.getTime();
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const dd = Math.floor(h / 24);
  if (dd < 30) return dd + "d ago";
  return new Date(ts).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

export const dateStr = (t: Date | number) =>
  new Date(t).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export const initials = (name?: string | null) =>
  (name || "?").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft", received: "Received", processing: "Processing", ready: "Ready", collected: "Collected", cancelled: "Cancelled",
};

/* Loyalty by lifetime pieces washed.

   NOT Bronze/Silver/Gold — those are PLAN TIERS, and they decide the letter on
   the student's bag. Using the same three words for both put a "Bronze" pill
   next to a Silver plan on the very same card, which reads as a data error and
   is impossible for staff to interpret at a counter. Distinct words, so the
   two ideas can sit side by side without arguing. */
export function loyaltyBadge(pieces: number) {
  if (pieces >= 150) return { name: "Regular", bg: "#f6edd2", fg: "#8a6d12" };
  if (pieces >= 50) return { name: "Returning", bg: "#eceef1", fg: "#5b6570" };
  return { name: "New", bg: "#f2e4d8", fg: "#8a5a34" };
}

export function upiLink(upiId: string, payeeName: string, amount: number, note: string) {
  return `upi://pay?pa=${encodeURIComponent(upiId)}&pn=${encodeURIComponent(payeeName || "FabricFold")}&am=${encodeURIComponent(Number(amount).toFixed(2))}&cu=INR&tn=${encodeURIComponent(note || "FabricFold")}`;
}
