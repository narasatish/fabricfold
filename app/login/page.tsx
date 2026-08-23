import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { liveSession } from "@/lib/auth";
import LoginForm from "./_components/LoginForm";

// A logged-in user hitting /login (e.g. via "Open app" on the marketing site)
// is sent straight to their app instead of seeing the login form again.
export const dynamic = "force-dynamic";

/* /login is listed in the sitemap, so it needs a canonical like every other
   indexed page — it was the one entry without one. The title is its own rather
   than the bare site name, because "FabricFold" alone told a searcher nothing
   about what the page does. */
export const metadata: Metadata = {
  title: "Sign in — FabricFold",
  description: "Sign in to FabricFold with your mobile number to book, track and collect your campus laundry.",
  alternates: { canonical: "https://fabricfold.in/login" },
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
