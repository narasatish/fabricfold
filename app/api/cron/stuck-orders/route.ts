/* Stuck-order check: any order still "received" or "processing" more than
   STUCK_HOURS after it was dropped off is listed in one owner email, so nothing
   sits unnoticed. Owner-triggered, or run by the cron with CRON_SECRET.
   Email only (the owner's WhatsApp list is limited to the core events). */
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { notifyOwner } from "@/lib/mail";
import { isCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const STUCK_HOURS = 6;

async function authorised(req: Request) {
  if (isCronRequest(req)) return true;
  const s = await getSession().catch(() => null);
  if (!s || s.mode !== "staff") return false;
  const st = await db.staff.findUnique({ where: { id: s.staffId } });
  return !!st && st.role >= 3; // Admin or Owner
}

export async function GET(req: Request) {
  if (!(await authorised(req))) return new Response("unauthorized", { status: 401 });

  const cutoff = new Date(Date.now() - STUCK_HOURS * 3_600_000);
  const stuck = await db.order.findMany({
    where: { status: { in: ["received", "processing"] }, receivedAt: { lt: cutoff } },
    include: { student: { select: { name: true, college: { select: { name: true } } } } },
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

  return Response.json({ ok: true, stuck: stuck.length });
}
