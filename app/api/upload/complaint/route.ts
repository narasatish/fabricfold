/* Photo upload for a complaint thread — usable by STUDENTS as well as staff.

   /api/upload/intake is staff-only, which meant a student could never attach a
   photo of their own damaged clothes even though sendComplaintMessage accepts
   them. This route is the student-facing equivalent.

   Stored in the same bucket as intake photos so /api/complaint-photo can serve
   them back under its own ownership check. */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getSession } from "@/lib/auth";
import { sniffMatchesType } from "@/lib/file-sniff";

const MAX_BYTES = 8 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp"];

export async function POST(req: Request) {
  // Any signed-in user may upload; what they can later VIEW is enforced
  // separately, per key, by /api/complaint-photo.
  const s = await getSession().catch(() => null);
  if (!s) return new Response("unauthorized", { status: 401 });

  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return new Response("no file", { status: 400 });
  if (file.size > MAX_BYTES) return new Response("max 8 MB", { status: 413 });
  if (!ALLOWED.includes(file.type)) return new Response("jpeg/png/webp only", { status: 415 });

  const ext = file.type.split("/")[1];
  const key = `intake/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  if (!sniffMatchesType(bytes, file.type)) return new Response("file content doesn't match its type", { status: 415 });

  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (supaUrl && supaKey) {
    const bucket = process.env.SUPABASE_BUCKET || "receipts";
    const res = await fetch(`${supaUrl}/storage/v1/object/${bucket}/${key}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${supaKey}`, apikey: supaKey, "Content-Type": file.type, "x-upsert": "true" },
      body: bytes,
    });
    if (!res.ok) return new Response("storage upload failed", { status: 502 });
    return Response.json({ ok: true, key });
  }

  // dev fallback: local disk, shared with the other upload routes
  const dir = path.join(process.cwd(), "public", "uploads", "receipts");
  await mkdir(dir, { recursive: true });
  const fname = key.replace("/", "-");
  await writeFile(path.join(dir, fname), bytes);
  return Response.json({ ok: true, key: `local/${fname}` });
}
