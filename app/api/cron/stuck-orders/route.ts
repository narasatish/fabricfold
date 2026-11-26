/* Stuck-order check: any order still "received" or "processing" more than
   STUCK_HOURS after it was dropped off is listed in one owner email, so nothing
   sits unnoticed. Owner-triggered, or run by the cron with CRON_SECRET.

   2026-11: now also pushes the affected STUDENT an apology, once per order
   (Order.delayNotifiedAt, same idempotency pattern as Complaint.escalatedAt)
   — the owner email alone never reached the person actually waiting on
   their laundry. The owner's WhatsApp list stays limited to the core
   events; this is email (owner) + push (student), not a new WhatsApp use. */
import { db } from "@/lib/db";
import { notifyOwner } from "@/lib/mail";
import { isCronOrStaff } from "@/lib/cron-auth";
import { pushNotif } from "@/lib/notify";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STUCK_HOURS = 6;
const DELAY_APOLOGY =
  "There's a delay in processing your order — we're sorry for the inconvenience. We're on it and expect it sorted by the end of this week.";

async function authorised(req: Request) {
  return isCronOrStaff(req, 3); // Admin or Owner
}

export async function GET(req: Request) {
  if (!(await authorised(req))) return new Response("unauthorized", { status: 401 });

  const cutoff = new Date(Date.now() - STUCK_HOURS * 3_600_000);
  const stuck = await db.order.findMany({
    where: { status: { in: ["received", "processing"] }, receivedAt: { lt: cutoff } },
    include: { student: { select: { id: true, name: true, college: { select: { name: true } } } } },
    orderBy: { receivedAt: "asc" },
    take: 200,
  });

  if (stuck.length === 0) return Response.json({ ok: true, stuck: 0 });

  const lines = stuck.map((o) => {
    const hours = Math.floor((Date.now() - (o.receivedAt?.getTime() ?? Date.now())) / 3_600_000);
    return `#${o.id.slice(-4)} · ${o.student.name} (${o.student.college?.name ?? "—"}) · ${o.status} for ${hours}h`;
  });

  await notifyOwner(
    `Stuck orders — ${stuck.length} waiting over ${STUCK_HOURS}h`,
    `These orders have not moved on for more than ${STUCK_HOURS} hours:\n\n${lines.join("\n")}`,
  );

  const toNotify = stuck.filter((o) => !o.delayNotifiedAt);
  for (const o of toNotify) {
    await pushNotif(o.student.id, DELAY_APOLOGY, "status");
  }
  if (toNotify.length) {
    await db.order.updateMany({ where: { id: { in: toNotify.map((o) => o.id) } }, data: { delayNotifiedAt: new Date() } });
  }

  return Response.json({ ok: true, stuck: stuck.length, studentsNotified: toNotify.length });
}
