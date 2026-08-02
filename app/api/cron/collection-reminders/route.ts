/* "Your laundry is still waiting" nudges.

   Uncollected bags are the biggest physical problem in a campus laundry — the
   shelves fill up and nobody can find anything. A ready order gets a nudge at
   ~24h and again at ~48h, then stops: past that it's a conversation for the
   counter, not another notification the student has learned to ignore.

   Reminders are COUNTED on the order rather than flagged, so the daily cron
   can't re-send the same nudge every run while a bag sits there for a
   fortnight. Runs daily, or Owner-triggered. */
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { pushNotif } from "@/lib/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Hours after the order became ready at which each nudge goes out. */
const REMINDER_HOURS = [24, 48];

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

  let sent = 0, checked = 0;
  try {
    const ready = await db.order.findMany({
      where: { status: "ready", collectionRemindersSent: { lt: REMINDER_HOURS.length } },
      include: { timeline: { where: { status: "ready" }, orderBy: { at: "desc" }, take: 1 } },
      take: 500,
    });

    for (const o of ready) {
      checked++;
      const readyAt = o.timeline[0]?.at;
      if (!readyAt) continue; // no ready event recorded — nothing to measure from

      const hours = (Date.now() - readyAt.getTime()) / 3_600_000;
      const due = REMINDER_HOURS[o.collectionRemindersSent];
      if (due === undefined || hours < due) continue;

      const days = Math.floor(hours / 24);
      await pushNotif(
        o.studentId,
        days >= 2
          ? `Your order #${o.id.slice(-4)} has been ready for ${days} days — please collect it from the counter.`
          : `Your order #${o.id.slice(-4)} is ready and waiting — please collect it from the counter.`,
        "ready",
      );
      await db.order.update({
        where: { id: o.id },
        data: { collectionRemindersSent: { increment: 1 } },
      });
      sent++;
    }
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message, checked, sent }, { status: 500 });
  }

  return Response.json({ ok: true, checked, sent });
}
