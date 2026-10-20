/* Google Sheets live sync — business figures only, NEVER student PII.

   Called by the daily Vercel cron and by an external 10-min scheduler
   (cron-job.org) with Bearer CRON_SECRET, or by the Owner via the Admin button.
   All the work lives in lib/sheets-sync.ts (shared with the server action). */
import { db } from "@/lib/db";
import { runSheetsSync } from "@/lib/sheets-sync";
import { isCronOrStaff } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function authorised(req: Request) {
  return isCronOrStaff(req, 4); // Owner only
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
