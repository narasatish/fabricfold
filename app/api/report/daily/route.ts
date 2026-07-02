/* Daily owner report — content from reportText(). Wire to Vercel Cron
   ("0 21 * * *" IST via vercel.json) or trigger manually from Reports.
   Email delivery uses a MailProvider interface; dev logs to console. */
import { db } from "@/lib/db";
import { parsePeriod, reportText } from "@/lib/report";
import { requireStaff } from "@/lib/auth";

async function sendMail(to: string, subject: string, text: string) {
  console.log(`[MAIL -> ${to}] ${subject}\n${text}`);
}

export async function POST() {
  try {
    await requireStaff(2);
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  return run();
}

/* Vercel Cron calls GET with the CRON_SECRET Authorization header. */
export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return run();
}

async function run() {
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const settings = cfg.settings as { reportEmail?: string; dailyEmail?: boolean; lastSent?: string | null };
  const text = await reportText(parsePeriod({ p: "day" }));
  const to = settings.reportEmail || "owner@fabricfold.in";
  await sendMail(to, "FabricFold — today's report", text);
  await db.appConfig.update({
    where: { id: "main" },
    data: { settings: JSON.parse(JSON.stringify({ ...settings, lastSent: new Date().toISOString() })) },
  });
  return Response.json({ ok: true, to });
}
