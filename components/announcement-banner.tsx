/* Staff/owner-authored notice shown on every customer screen (see
   app/c/layout.tsx). Separate from SafePaymentBanner (a fixed anti-fraud
   notice) — this one carries whatever text staff set via
   lib/actions/admin.ts setAnnouncementBanner, e.g. "Machines down Tuesday
   10am-1pm" or "Diwali break: no collections Nov 14-16". Renders nothing
   when no banner is active, so this never adds an empty bar. */
export function AnnouncementBanner({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div
      style={{
        background: "var(--teal-soft)",
        color: "var(--teal-dark)",
        fontSize: 12.5,
        lineHeight: 1.4,
        padding: "8px 16px",
        textAlign: "center",
        fontWeight: 600,
      }}
    >
      {text}
    </div>
  );
}
