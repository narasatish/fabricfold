import { db } from "./db";

/* Owner email notifications.
   Provider: Resend (free tier: 100/day) when RESEND_API_KEY is set; until
   then messages are logged to the server console so nothing breaks.
   Recipient: Admin → "Daily report & drawer" → owner report email
   (fallback: OWNER_EMAIL env var). All sends are fire-and-forget — a mail
   outage never blocks an order. */

async function ownerEmail(): Promise<string | null> {
  if (process.env.OWNER_EMAIL) return process.env.OWNER_EMAIL;
  const cfg = await db.appConfig.findUnique({ where: { id: "main" } });
  const s = cfg?.settings as { reportEmail?: string } | null;
  return s?.reportEmail || null;
}

export async function sendMail(to: string, subject: string, text: string) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[MAIL -> ${to}] ${subject}\n${text}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || "FabricFold <onboarding@resend.dev>",
      to: [to],
      subject,
      text,
    }),
  });
  if (!res.ok) console.error("mail send failed", res.status, await res.text().catch(() => ""));
}

/** Notify the owner about a business event. Never throws. */
export async function notifyOwner(subject: string, text: string) {
  try {
    const to = await ownerEmail();
    if (!to) return; // owner email not configured yet
    await sendMail(to, `FabricFold · ${subject}`, text);
  } catch (e) {
    console.error("notifyOwner failed", e);
  }
}
