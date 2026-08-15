/* Drain the Sheet outbox — the reliability half of the live log.

   Separate from /api/sheets/sync on purpose. That route rebuilds the whole
   aggregate workbook and is slow enough to want running once a day; this one
   appends whatever is queued and is cheap enough to run every minute.

   Why it exists at all when actions already call flushSoon(): a serverless
   function can be frozen the moment its response is sent, so a fire-and-forget
   flush is an optimisation that may never actually execute. This sweep is what
   turns "usually within seconds" into "always, eventually".

   Idempotent — rows are marked sent only once Google has accepted them, so a
   double invocation cannot duplicate or lose anything. */
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { flushSheetOutbox, pruneSheetOutbox, MAX_ATTEMPTS } from "@/lib/sheet-events";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function authorised(req: Request) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  const s = await getSession().catch(() => null);
  if (!s || s.mode !== "staff") return false;
  const st = await db.staff.findUnique({ where: { id: s.staffId } });
  return !!st && st.role >= 3; // Admin+ may force a flush from the app
}

export async function GET(req: Request) {
  if (!(await authorised(req))) return new Response("unauthorized", { status: 401 });
  try {
    const r = await flushSheetOutbox();
    const pruned = await pruneSheetOutbox();

    /* Rows that exhausted their retries are reported, not hidden. Silence here
       would mean orders quietly missing from the Sheet with nothing to show
       for it — the exact failure this whole mechanism exists to avoid. */
    const stuck = await db.sheetOutbox.count({ where: { sentAt: null, attempts: { gte: MAX_ATTEMPTS } } });
    return Response.json({ ...r, pruned, stuck }, { status: r.ok ? 200 : 503 });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("sheets flush failed:", msg);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}
