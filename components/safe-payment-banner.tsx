/* Persistent anti-fraud notice shown on every customer screen (see
   app/c/layout.tsx). Owner-reported 2026-11: some staff have been taking UPI
   payments to their own personal number/QR instead of the college's official
   one, with no way for the student to tell the difference at the counter.
   This can't stop that by itself, but it puts the ONE fact students need —
   the official UPI ID, repeated every time they open the app — in front of
   them, so a personal QR looks obviously wrong instead of unremarkable. */
export function SafePaymentBanner({ payeeName }: { payeeName: string }) {
  if (!payeeName) return null;
  return (
    <div
      style={{
        background: "var(--amber-soft)",
        color: "var(--amber)",
        fontSize: 12.5,
        lineHeight: 1.4,
        padding: "8px 16px",
        textAlign: "center",
        fontWeight: 600,
      }}
    >
      Pay to <span style={{ fontWeight: 800 }}>{payeeName}</span> only — use that QR, never a staff member&apos;s personal number or QR.
    </div>
  );
}
