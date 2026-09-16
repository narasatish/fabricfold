/* Daily owner report — today + this week + this month + the current backlog,
   composed by dailyEmailReport(). Wire to Vercel Cron ("0 21 * * *" IST via
   vercel.json) or trigger manually from Reports.
   Delivery via lib/mail (Resend when configured; console otherwise). */
import { db } from "@/lib/db";
import { dailyEmailReport } from "@/lib/report";
import { requireStaff } from "@/lib/auth";
import { sendMail } from "@/lib/mail";
import { isCronRequest } from "@/lib/cron-auth";

export async function POST() {
  try {
    await requireStaff(2);
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  // A staff member clicking "Email today's report" is a deliberate, one-off
  // request for the report right now — it must always go through, even
  // minutes after the automated cron already sent one today.
  return run(false);
}

/* Vercel Cron calls GET with the CRON_SECRET Authorization header. */
export async function GET(req: Request) {
  if (!isCronRequest(req)) {
    return new Response("unauthorized", { status: 401 });
  }
  return run(true);
}

async function run(guardRetries: boolean) {
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const settings = cfg.settings as { reportEmail?: string; dailyEmail?: boolean; lastSent?: string | null };
  // Guards a retried cron trigger (Render retrying a failed run) from
  // double-emailing the owner within the same firing — collection-reminders
  // and error-digest already guard their own sends this way; weekly-digest
  // got the same fix earlier. Scoped to the CRON path only (short window):
  // the manual "Email today's report" button in Reports is a deliberate
  // request and must never be silently swallowed by this guard.
  const lastSent = settings.lastSent ? new Date(settings.lastSent) : null;
  if (guardRetries && lastSent && Date.now() - lastSent.getTime() < 15 * 60_000) {
    return Response.json({ ok: true, skipped: "already sent moments ago" });
  }
  const text = await dailyEmailReport();
  const to = settings.reportEmail || "owner@fabricfold.in";
  await sendMail(to, "FabricFold — daily report", text);
  await db.appConfig.update({
    where: { id: "main" },
    data: { settings: JSON.parse(JSON.stringify({ ...settings, lastSent: new Date().toISOString() })) },
  });
  return Response.json({ ok: true, to });
}
