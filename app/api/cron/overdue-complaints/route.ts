/* 2026-11-01: owner's complaint was "as staff, they are ignoring complaints."
   The complaint screen already shows an "Overdue" badge once respondBy has
   passed (app/s/complaints/_components/ComplaintsClient.tsx) — but a badge
   on a page nobody opens changes nothing. This is the active half: an
   owner email the moment a complaint is overdue, same shape as the existing
   stuck-orders check (app/api/cron/stuck-orders/route.ts), so staff
   inaction surfaces to the person who can act on it instead of staying
   silent on a list view.

   escalatedAt makes this idempotent across runs: once a complaint has been
   reported overdue, it is not re-emailed every run — one ping per
   complaint, not a flood, however many times the cron fires before someone
   resolves it. Owner-triggered, or run by the cron with CRON_SECRET. */
import { db } from "@/lib/db";
import { notifyOwner } from "@/lib/mail";
import { isCronOrStaff } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function authorised(req: Request) {
  return isCronOrStaff(req, 3); // Admin or Owner
}

export async function GET(req: Request) {
  if (!(await authorised(req))) return new Response("unauthorized", { status: 401 });

  const overdue = await db.complaint.findMany({
    where: { status: "open", respondBy: { lt: new Date() }, escalatedAt: null },
    include: { student: { select: { name: true, college: { select: { name: true } } } } },
    orderBy: { respondBy: "asc" },
    take: 200,
  });

  if (overdue.length === 0) return Response.json({ ok: true, overdue: 0 });

  const lines = overdue.map((c) => {
    const hours = Math.floor((Date.now() - (c.respondBy?.getTime() ?? Date.now())) / 3_600_000);
    return `#${c.id.slice(-4)} · ${c.student.name} (${c.student.college?.name ?? "—"}) · overdue ${hours}h · "${c.text.slice(0, 100)}"`;
  });

  await notifyOwner(
    `Overdue complaints — ${overdue.length} unresolved past deadline`,
    `These complaints have passed their 24h response deadline with no reply:\n\n${lines.join("\n")}`,
  );

  // updateMany with escalatedAt: null still in the WHERE, so a complaint
  // resolved or re-escalated between the query and this write isn't clobbered.
  await db.complaint.updateMany({
    where: { id: { in: overdue.map((c) => c.id) }, escalatedAt: null },
    data: { escalatedAt: new Date() },
  });

  return Response.json({ ok: true, overdue: overdue.length });
}
