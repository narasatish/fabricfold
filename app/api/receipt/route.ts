/* View an expense receipt: local dev files redirect to /uploads; Supabase keys
   get a short-lived signed URL. Staff-only. */
import { requireStaff } from "@/lib/auth";

export async function GET(req: Request) {
  try {
    await requireStaff(1);
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const key = new URL(req.url).searchParams.get("key") || "";
  if (!key) return new Response("no key", { status: 400 });

  if (key.startsWith("local/")) {
    return Response.redirect(new URL("/uploads/receipts/" + key.slice(6), req.url), 302);
  }
  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey) return new Response("storage not configured", { status: 503 });
  const bucket = process.env.SUPABASE_BUCKET || "receipts";
  const res = await fetch(`${supaUrl}/storage/v1/object/sign/${bucket}/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${supaKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: 600 }),
  });
  if (!res.ok) return new Response("sign failed", { status: 502 });
  const j = (await res.json()) as { signedURL: string };
  return Response.redirect(supaUrl + "/storage/v1" + j.signedURL, 302);
}
