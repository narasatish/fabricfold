import { requireStudentOrRedirect } from "@/lib/auth";
import { redirect } from "next/navigation";

/* Owner, 2026-11: students no longer place their own orders — staff create
   the order at the counter after scanning the student's one-time QR
   (lib/actions/students.ts createScanCode). placeOrder() itself refuses
   unconditionally now (lib/actions/orders.ts); this route just keeps a
   direct link or old bookmark from reaching a dead form instead of /c. */
export default async function OrderNewPage() {
  await requireStudentOrRedirect();
  redirect("/c");
}
