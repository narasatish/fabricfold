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

/* Tables are DERIVED from the Prisma schema, never hand-listed.

   The previous hand-maintained list had drifted badly: Plan, Bag, DayClose,
   Attendance and SlotWindow were all absent, so a restore would have produced
   students and orders with no plans and no idea which bag belonged to whom.
   A backup you trust but which silently omits tables is worse than none.

   Deriving means a new model is included the day it is added. */
const SKIP = new Set([
  // Login codes, valid for five minutes. Pointless to restore, and a snapshot
  // full of live OTPs is a liability rather than an asset.
  "otp",
]);

/* Enumerated from the live client rather than Prisma.dmmf, which Prisma 7 no
   longer exposes. Every model delegate is an own key with a findMany, so this
   picks up a new table the moment it exists. */
function backupTables(): string[] {
  return Object.keys(db as object)
    .filter((k) => !k.startsWith("$") && !k.startsWith("_"))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((k) => typeof (db as any)[k]?.findMany === "function")
    .filter((k) => !SKIP.has(k))
    .sort();
}

async function snapshot() {
  const out: Record<string, unknown[]> = {};
  for (const key of backupTables()) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out[key] = await (db as any)[key].findMany();
  }
  return {
    app: "fabricfold",
    version: 2, // v2: table list derived from the schema, not hand-maintained
    takenAt: new Date().toISOString(),
    // Recorded so an incomplete snapshot is visible on inspection rather than
    // only discovered during a restore.
    tables: Object.keys(out).length,
    skipped: [...SKIP],
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

    const url = new URL(req.url);

    /* ?check — WHERE do off-site backups go? Names the storage host and
       whether it answers; never a key. Exists because the Sydney→Mumbai
       migration left this exact question unanswerable from outside: the env
       vars are sensitive, the dashboard shows only one project at a time,
       and "backups are configured" is not "backups are landing". */
    if (url.searchParams.get("check") !== null) {
      const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
      if (!base || !key) return Response.json({ configured: false });
      const probe = await fetch(`${base}/storage/v1/bucket/backups`, {
        headers: { Authorization: `Bearer ${key}`, apikey: key },
      }).catch(() => null);
      return Response.json({
        configured: true,
        host: new URL(base).host,
        bucketExists: probe?.ok ?? false,
        bucketStatus: probe?.status ?? "unreachable",
      });
    }

    /* ?upload — the nightly push, on demand. The Owner should not have to
       wait for 1:30am to prove a backup lands after fixing storage. */
    if (url.searchParams.get("upload") !== null) {
      return pushToStorage();
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
  return pushToStorage();
}

async function pushToStorage() {
  const base = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!base || !key) return new Response("storage not configured — set SUPABASE_URL & SUPABASE_SERVICE_KEY", { status: 503 });

  const snap = await snapshot();
  const name = `auto/fabricfold-${snap.takenAt.slice(0, 10)}-${snap.takenAt.slice(11, 19).replace(/:/g, "")}.json`;
  const res = await fetch(`${base}/storage/v1/object/backups/${name}`, {
    method: "POST",
    // new-style sb_secret_ keys need BOTH headers; legacy JWT keys tolerate both.
    headers: { Authorization: `Bearer ${key}`, apikey: key, "Content-Type": "application/json", "x-upsert": "false" },
    body: JSON.stringify(snap),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("backup upload failed", res.status, detail);
    // The DETAIL reaches the caller: "Bucket not found" and "bad key" need
    // different fixes, and a bare 500 hid that difference for weeks.
    return new Response(`backup upload failed (${res.status}): ${detail.slice(0, 300)}`, { status: 500 });
  }
  return Response.json({ ok: true, stored: name, counts: snap.counts });
}
