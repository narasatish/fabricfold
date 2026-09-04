/* Weekly owner digest — Monday morning, the previous 7 days in one email.

   The daily report answers "how was today"; this answers "how is the
   business" — the numbers worth a minute once a week: revenue split by
   method, order volume, complaints (and how many are still open), new
   students, and the bags that have sat ready for more than 5 days, because
   an uncollected bag is shelf space and a student who has forgotten. */
import { db } from "@/lib/db";
import { sendMail } from "@/lib/mail";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const cfg = await db.appConfig.findUnique({ where: { id: "main" } });
  const settings = (cfg?.settings as { reportEmail?: string; lastWeeklyDigestAt?: string } | null) ?? {};
  const to = settings.reportEmail || process.env.OWNER_EMAIL;
  if (!to) return Response.json({ ok: false, reason: "no owner email configured" });

  // Guards a retried/duplicate trigger in the same window from double-emailing
  // the owner — collection-reminders and error-digest already have their own
  // equivalent guard, this one was missing it.
  const lastSent = settings.lastWeeklyDigestAt ? new Date(settings.lastWeeklyDigestAt) : null;
  if (lastSent && Date.now() - lastSent.getTime() < 6 * 86_400_000) {
    return Response.json({ ok: true, skipped: "already sent this week" });
  }

  const since = new Date(Date.now() - 7 * 86_400_000);
  const N = (x: unknown) => Number(x || 0);

  const [payments, orders, complaints, openComplaints, newStudents, ready] = await Promise.all([
    db.payment.findMany({ where: { at: { gte: since }, amount: { gt: 0 } }, select: { amount: true, method: true } }),
    db.order.count({ where: { createdAt: { gte: since } } }),
    db.complaint.count({ where: { at: { gte: since } } }),
    db.complaint.count({ where: { status: "open" } }),
    db.student.count({ where: { createdAt: { gte: since } } }),
    // Bags sitting ready — the age check uses the ready event, not createdAt:
    // an order can spend days in processing before it ever waits on a student.
    db.order.findMany({
      where: { status: "ready", timeline: { some: { status: "ready", at: { lt: new Date(Date.now() - 5 * 86_400_000) } } } },
      select: { id: true, student: { select: { name: true } } },
      take: 30,
    }),
  ]);

  const byMethod = new Map<string, number>();
  for (const p of payments) byMethod.set(p.method, (byMethod.get(p.method) || 0) + N(p.amount));
  const revenue = [...byMethod.values()].reduce((s, v) => s + v, 0);
  const split = [...byMethod.entries()].map(([m, v]) => `${m} ₹${Math.round(v)}`).join(" · ") || "none";

  const stale = ready.length
    ? `\n\nUNCOLLECTED 5+ DAYS (${ready.length}):\n` + ready.map((o) => `  #${o.id.slice(-6)} — ${o.student.name}`).join("\n")
    : "\n\nNo bags waiting over 5 days.";

  await sendMail(
    to,
    `FabricFold — week in review: ₹${Math.round(revenue)}, ${orders} orders`,
    `Last 7 days\n\n` +
      `Revenue: ₹${Math.round(revenue)}  (${split})\n` +
      `Orders: ${orders}\n` +
      `New students: ${newStudents}\n` +
      `Complaints: ${complaints} new · ${openComplaints} still open` +
      stale,
  );

  await db.appConfig.update({
    where: { id: "main" },
    data: { settings: { ...settings, lastWeeklyDigestAt: new Date().toISOString() } },
  });

  return Response.json({ ok: true, revenue: Math.round(revenue), orders, newStudents, staleReady: ready.length });
}
