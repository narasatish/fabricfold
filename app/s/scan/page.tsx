import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import ScanClient from "./_components/ScanClient";

/* Found 2026-11-23 via tests/route-guards.test.ts: this page was shipped as
   a bare "use client" component with no server-side staff check of its
   own — every other /s page establishes WHO is asking (requireStaff or
   this same getSession + mode check) before rendering anything, precisely
   because this Next.js version has no portable middleware net (proxy.ts's
   comment: Cloudflare Workers can't run it, so anywhere but Vercel the net
   is gone). Split into this server-guarded shell + a client component for
   the camera logic, matching app/s/page.tsx's own pattern exactly. */
export default async function StaffScanPage() {
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect("/login");
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");

  return <ScanClient />;
}
