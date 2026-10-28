/* Shared Sentry `beforeSend` filter — server, edge and client configs all
   use this, so there is one place that decides what's noise.

   Found 2026-10-28 via a real Sentry alert email: "Not signed in" on a POST
   to /c/profile. AuthError (lib/auth.ts) is thrown by requireStudent/
   requireStaff exactly when a session is missing, expired, revoked, or
   belongs to a deactivated account — a routine, EXPECTED control-flow
   signal every server action in this codebase is written to catch and show
   as a friendly message (or silently redirect to /login, see
   ProfileClient.tsx's handleLogout/handleSignOutEverywhere). It fires
   constantly in normal use — any student whose 365-day session was revoked,
   who cleared cookies, or who has a stale tab open across a deploy will
   trip it the next time they tap something. None of that is a bug.

   Before this filter, every single occurrence was reported to Sentry as a
   production error and could trigger Sentry's own alert emails — the exact
   kind of noise that makes a real error digest (lib/mail.ts's
   error-digest, fixed the same week to actually reach the owner) less
   useful, not more: an owner who gets paged for routine session expiry
   learns to ignore the channel, which is worse than no alerting at all. */
export function isExpectedAuthNoise(hint: { originalException?: unknown }): boolean {
  const err = hint.originalException;
  if (!err || typeof err !== "object") return false;
  // Checking the constructor name rather than `instanceof AuthError` on
  // purpose: Sentry's config files load before most of the app's module
  // graph, and importing lib/auth.ts here would pull in `next/headers`
  // (cookies()) into the Sentry init path, which runs in contexts (edge,
  // very early server boot) where that import can itself throw. A name
  // check is all a case this narrow actually needs.
  return (err as { name?: unknown }).name === "AuthError";
}
