/* Damage/intake photo upload at the counter. Any staff (role 1+). Images only.
   Stored in the same 'receipts' bucket so /api/receipt?key=... can view it. */
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { requireStaff } from "@/lib/auth";
import { sniffMatchesType } from "@/lib/file-sniff";

export async function POST(req: Request) {
  try {
    await requireStaff(1);
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const form = await req.formData();
  const file = form.get("file") as File | null;
  if (!file) return new Response("no file", { status: 400 });
  if (file.size > 8 * 1024 * 1024) return new Response("max 8 MB", { status: 413 });
  const ok = ["image/jpeg", "image/png", "image/webp"];
  if (!ok.includes(file.type)) return new Response("jpeg/png/webp only", { status: 415 });

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

  // dev fallback: local disk under public/uploads/receipts (shared view route)
  const dir = path.join(process.cwd(), "public", "uploads", "receipts");
  await mkdir(dir, { recursive: true });
  const fname = key.replace("/", "-");
  await writeFile(path.join(dir, fname), bytes);
  return Response.json({ ok: true, key: `local/${fname}` });
}
