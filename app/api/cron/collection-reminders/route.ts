/* "Your laundry is still waiting" nudges.

   Uncollected bags are the biggest physical problem in a campus laundry — the
   shelves fill up and nobody can find anything. A ready order gets a nudge at
   ~24h and again at ~48h, then stops: past that it's a conversation for the
   counter, not another notification the student has learned to ignore.

   Reminders are COUNTED on the order rather than flagged, so the daily cron
   can't re-send the same nudge every run while a bag sits there for a
   fortnight. Runs daily, or Owner-triggered. */
import { db } from "@/lib/db";
import { pushNotif } from "@/lib/notify";
import { isCronOrStaff } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Hours after the order became ready at which each nudge goes out. */
const REMINDER_HOURS = [24, 48];

async function authorised(req: Request) {
  return isCronOrStaff(req, 4); // Owner only
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

      // Claim the increment BEFORE sending, not after: updateMany with the
      // counter's last-known value in the WHERE clause only succeeds for
      // whichever run gets there first — an overlapping concurrent run (a
      // slow run + a retry, the same scenario weekly-digest/daily-report
      // guard against with a timestamp) reads the same stale counter, loses
      // the claim, and must not also send. Same "claim via updateMany count"
      // pattern already used for waVerify/complaint.redoOrderId elsewhere in
      // this codebase.
      const claimed = await db.order.updateMany({
        where: { id: o.id, collectionRemindersSent: o.collectionRemindersSent },
        data: { collectionRemindersSent: { increment: 1 } },
      });
      if (claimed.count === 0) continue; // another run already claimed this nudge

      const days = Math.floor(hours / 24);
      await pushNotif(
        o.studentId,
        days >= 2
          ? `Your order #${o.id.slice(-4)} has been ready for ${days} days — please collect it from the counter.`
          : `Your order #${o.id.slice(-4)} is ready and waiting — please collect it from the counter.`,
        "ready",
      );
      sent++;
    }
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message, checked, sent }, { status: 500 });
  }

  return Response.json({ ok: true, checked, sent });
}
