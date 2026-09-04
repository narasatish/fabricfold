import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { liveSession } from "@/lib/auth";
import { db } from "@/lib/db";
import RegisterForm from "./_components/RegisterForm";

// A logged-in user hitting /join/bvrit is sent straight to their app.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Join FabricFold — BVRIT",
  description: "Self-register as a BVRIT student with FabricFold to start using campus laundry service immediately.",
  robots: { index: false }, // onboarding page, not a search destination
};

export default async function BvritRegisterPage() {
  const s = await liveSession();
  if (s?.mode === "customer") redirect("/c");
  if (s?.mode === "staff") redirect("/s");

  // Look up BVRIT's college ID
  const college = await db.college.findFirst({ where: { name: "BVRIT", active: true } });
  if (!college) {
    return (
      <div className="screen no-nav">
        <div className="pad" style={{ paddingTop: 40, textAlign: "center" }}>
          <h1 className="h-lg">Registration unavailable</h1>
          <p className="muted mt12" style={{ fontSize: 14 }}>
            BVRIT registration is not currently set up. Please visit the counter.
          </p>
        </div>
      </div>
    );
  }

  return <RegisterForm collegeId={college.id} collegeName={college.name} />;
}
