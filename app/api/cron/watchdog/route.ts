/* DISABLED (owner, Oct 2026: "too many notifications, remove watchdog").
   This used to email the owner every 5 minutes for any new "server" kind
   ErrorLog rows. That alert is now OFF — real server errors still land in
   Admin -> App Errors (nothing here marks them seen) and still get rolled
   into the once-a-day error-digest email; only the instant per-5-minute
   ping is gone. The "database unreachable" case stays silent the same way.
   cron-uptime-watchdog (render.yaml) is the one alert that still fires
   immediately, and only when the site is fully down — it was built to not
   depend on this endpoint for exactly that reason.

   Kept as a GET, rather than deleted, so Render's existing every-5-minute
   cron job keeps hitting a harmless no-op instead of needing a render.yaml
   or dashboard change to stop it. */
import { db } from "@/lib/db";
import { isCronOrStaff } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function authorised(req: Request) {
  return isCronOrStaff(req, 4); // Owner only
}

export async function GET(req: Request) {
  if (!(await authorised(req))) return new Response("unauthorized", { status: 401 });

  // Count only, for the response body — no email, no "seen" write. The
  // daily digest is the only remaining alert for these.
  let unseen = 0;
  try {
    unseen = await db.errorLog.count({ where: { seen: false, kind: "server" } });
  } catch {
    return Response.json({ ok: false, error: "db unreachable" }, { status: 200 });
  }
  return Response.json({ ok: true, errors: unseen, sent: false });
}
