/* Full-database backup.
   - GET by the Owner (role 4) in the browser → downloads a complete JSON
     snapshot of every table (works today, no extra setup).
   - GET by Vercel Cron (Bearer CRON_SECRET) → uploads the same snapshot to
     Supabase Storage bucket "backups" (needs SUPABASE_URL + SERVICE_KEY),
     giving an automatic nightly off-database copy that survives anything.
   Backups are additive — old snapshots are never overwritten (timestamped). */
import { db } from "@/lib/db";
import { requireStaff } from "@/lib/auth";

export const dynamic = "force-dynamic";

const TABLES = [
  "college", "student", "staff", "subscription", "cycleUse", "order", "orderEvent",
  "garmentTag", "payment", "invoice", "creditNote", "fySequence", "creditUse",
  "compensation", "expense", "payslip", "complaint", "complaintMessage",
  "notification", "auditLog", "appConfig",
] as const;

async function snapshot() {
  const out: Record<string, unknown[]> = {};
  for (const t of TABLES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out[t] = await (db as any)[t].findMany();
  }
  return {
    app: "fabricfold",
    version: 1,
    takenAt: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])),
    data: out,
  };
}

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  const isCron = !!process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`;

  if (!isCron) {
    // Browser path: Owner only.
    try {
      await requireStaff(4);
    } catch {
      return new Response("unauthorized", { status: 401 });
    }
    const snap = await snapshot();
    const name = `fabricfold-backup-${snap.takenAt.replace(/[:.]/g, "-")}.json`;
    return new Response(JSON.stringify(snap), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  // Cron path: push the snapshot to Supabase Storage.
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) return new Response("storage not configured — set SUPABASE_URL & SUPABASE_SERVICE_KEY", { status: 503 });

  const snap = await snapshot();
  const name = `auto/fabricfold-${snap.takenAt.slice(0, 10)}-${snap.takenAt.slice(11, 19).replace(/:/g, "")}.json`;
  const res = await fetch(`${base}/storage/v1/object/backups/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "x-upsert": "false" },
    body: JSON.stringify(snap),
  });
  if (!res.ok) {
    console.error("backup upload failed", res.status, await res.text().catch(() => ""));
    return new Response("backup upload failed", { status: 500 });
  }
  return Response.json({ ok: true, stored: name, counts: snap.counts });
}
