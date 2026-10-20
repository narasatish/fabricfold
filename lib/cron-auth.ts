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
import { requireStaff, AuthError } from "./auth";

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

/** Same centralizing idea, same root cause, found 2026-10-20 in a deep
    audit: seven of these cron/admin-tool routes also accept a staff-session
    fallback (so the Owner can trigger them by hand from the Admin screen),
    and every one of them had its OWN hand-rolled version of that check —
    `getSession()` + `db.staff.findUnique` + a bare `role >= N` comparison —
    which never checked `st.active` or `s.epoch === st.sessionEpoch` at all.
    `requireStaff()` is the ONE place in this codebase meant to gate staff
    access, specifically BECAUSE it re-checks both of those on every call —
    deactivating a staff member or using "sign out everywhere" is supposed
    to take effect immediately, not at the 365-day token's natural expiry
    (see setStaffActive's own comment on exactly this guarantee). A
    deactivated/revoked Owner or Admin's still-validly-SIGNED cookie could
    keep triggering these routes indefinitely — the same bug class already
    fixed once for /api/rt, just never applied to this second family of
    routes. Routes call this instead of rolling their own check again. */
export async function isCronOrStaff(req: Request, minRole: number): Promise<boolean> {
  if (isCronRequest(req)) return true;
  try {
    await requireStaff(minRole);
    return true;
  } catch (e) {
    if (e instanceof AuthError) return false;
    throw e;
  }
}
