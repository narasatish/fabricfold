import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { liveSession } from "@/lib/auth";
import LoginForm from "./_components/LoginForm";

// A logged-in user hitting /login (e.g. via "Open app" on the marketing site)
// is sent straight to their app instead of seeing the login form again.
export const dynamic = "force-dynamic";

/* Noindex, same as /get: a bare auth form (or an instant redirect for a
   signed-in visitor) isn't content worth a search result — and consistently
   excluded from BOTH the sitemap and the index, rather than the previous
   half-state of "canonicalised but not listed," which is exactly the kind
   of canonical/sitemap drift the SEO tests exist to catch. Its own title
   stays (rather than inheriting the bare site name) purely for the tab/
   bookmark a real visitor sees — noindex means search engines never render
   it either way. */
export const metadata: Metadata = {
  title: "Sign in — FabricFold",
  description: "Sign in to FabricFold with your mobile number to book, track and collect your campus laundry.",
  robots: { index: false },
};

export default async function LoginPage() {
  /* liveSession, not getSession: a cookie whose account was removed (or whose
     session was ended everywhere) must land HERE, on the form, not be bounced
     to an app that will refuse it. Signing in again overwrites the cookie. */
  const s = await liveSession();
  if (s?.mode === "customer") redirect("/c");
  if (s?.mode === "staff") redirect("/s");
  return <LoginForm />;
}
