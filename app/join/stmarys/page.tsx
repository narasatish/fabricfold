import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { liveSession } from "@/lib/auth";
import { db } from "@/lib/db";
import SignInForm from "./_components/SignInForm";

// A logged-in user hitting /join/stmarys is sent straight to their app.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sign in — FabricFold St Mary's",
  description: "Sign in to FabricFold as a St Mary's student, faculty member, or staff.",
  robots: { index: false }, // onboarding page, not a search destination
};

export default async function StMarysSignInPage() {
  const s = await liveSession();
  if (s?.mode === "customer") redirect("/c");
  if (s?.mode === "staff") redirect("/s");

  const college = await db.college.findFirst({ where: { name: "St Mary's", active: true } });
  if (!college) {
    return (
      <div className="screen no-nav">
        <div className="pad" style={{ paddingTop: 40, textAlign: "center" }}>
          <h1 className="h-lg">Sign-in unavailable</h1>
          <p className="muted mt12" style={{ fontSize: 14 }}>
            St Mary's sign-in is not currently set up. Please visit the counter.
          </p>
        </div>
      </div>
    );
  }

  return <SignInForm collegeName={college.name} />;
}
