/* View a photo attached to a complaint message.

   Separate from /api/receipt (staff-only) because a student must be able to see
   the damage evidence about their OWN clothes. Access is checked against the
   key itself: a student may only fetch a key that actually appears on one of
   their own complaint threads, so guessing another student's key gets nothing.

   Photos stay private in storage; this hands back a short-lived signed URL. */
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function mayView(key: string) {
  const s = await getSession().catch(() => null);
  if (!s) return false;
  if (s.mode === "staff") return true;
  if (s.mode !== "customer" || !s.studentId) return false;

  // The student may see this key only if it hangs off one of their own threads.
  const rows = await db.complaintMessage.findMany({
    where: { complaint: { studentId: s.studentId } },
    select: { photos: true },
    take: 500,
  });
  return rows.some((r) => Array.isArray(r.photos) && (r.photos as unknown[]).some((k) => String(k) === key));
}

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!key) return new Response("no key", { status: 400 });
  if (!(await mayView(key))) return new Response("unauthorized", { status: 401 });

  if (key.startsWith("local/")) {
    return Response.redirect(new URL("/uploads/receipts/" + key.slice(6), req.url), 302);
  }
  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey) return new Response("storage not configured", { status: 503 });
  const bucket = process.env.SUPABASE_BUCKET || "receipts";
  const res = await fetch(`${supaUrl}/storage/v1/object/sign/${bucket}/${encodeURI(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${supaKey}`, apikey: supaKey, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 600 }),
  });
  if (!res.ok) return new Response("sign failed", { status: 502 });
  const j = (await res.json()) as { signedURL: string };
  return Response.redirect(supaUrl + "/storage/v1" + j.signedURL, 302);
}
