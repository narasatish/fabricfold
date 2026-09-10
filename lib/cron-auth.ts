/* Shared Bearer-token check for CRON_SECRET, used by every cron/backup/report
   route that Vercel/Render's scheduler calls.

   Found 2026-09-05: every one of these routes had its own copy of
   `auth === \`Bearer ${secret}\`` — a plain string comparison. This codebase's
   OWN webhook routes (Razorpay, WhatsApp) deliberately use
   crypto.timingSafeEqual for the exact same kind of check, with their own
   comments explaining why: a public endpoint gating a real operation is
   worth defending against a timing side-channel even when the attack is
   impractical over real network jitter — free to avoid, so avoid it. The
   cron routes never got the same treatment; six near-identical copies of
   the weaker check, all doing the same job, none matching the lesson
   already learned and written down elsewhere in the same codebase.
   Centralized here instead of fixed six times separately, so a future
   cron/backup route gets this for free rather than needing the lesson
   re-learned again. */
import crypto from "node:crypto";

/** Is this request's Authorization header exactly `Bearer <CRON_SECRET>`?
    Returns false (never throws) if CRON_SECRET isn't configured — callers
    should treat that as "not authorised", not "skip the check". */
export function isCronRequest(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = req.headers.get("authorization") || "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(header, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
