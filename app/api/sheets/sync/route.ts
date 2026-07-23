/* Google Sheets live sync — business figures only, NEVER student PII.

   Called by the daily Vercel cron and by an external 10-min scheduler
   (cron-job.org) with Bearer CRON_SECRET, or by the Owner via the Admin button.
   All the work lives in lib/sheets-sync.ts (shared with the server action). */
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { runSheetsSync } from "@/lib/sheets-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function authorised(req: Request) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  const s = await getSession().catch(() => null);
  if (!s || s.mode !== "staff") return false;
  const st = await db.staff.findUnique({ where: { id: s.staffId } });
  return !!st && st.role >= 4; // Owner only
}

export async function GET(req: Request) {
  if (!(await authorised(req))) return new Response("unauthorized", { status: 401 });
  try {
    const r = await runSheetsSync();
    return Response.json(r, { status: r.ok ? 200 : 503 });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("sheets sync failed:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
