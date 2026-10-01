import { db } from "./db";
import { notifyOwnersWhatsApp } from "./notify";

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

/** Notify the owner about a business event — email AND instant WhatsApp
    (Admin -> Settings -> alert phone numbers), independently of each other:
    email being unconfigured must not silently skip WhatsApp, or vice versa.
    Never throws. */
export async function notifyOwner(subject: string, text: string) {
  /* TEMPORARY diagnostic (2026-10-01) — remove once the WhatsApp alert
     investigation is closed. Every known silent-failure path inside the
     WhatsApp send chain (missing credentials, zero alert numbers, an
     unexpected exception) now logs to ErrorLog — and still nothing showed
     up for a real, immediately-checked event. The remaining open question
     is whether notifyOwner() is being reached AT ALL for that event. This
     one unconditional line answers that directly: if this doesn't appear
     in Admin > App Errors right after the next test, the bug is upstream
     of here (the order/registration/payment action itself), not in the
     WhatsApp code anyone has been looking at so far. */
  await db.errorLog.create({ data: { kind: "server", message: `DEBUG: notifyOwner called — "${subject}"`.slice(0, 2000) } }).catch(() => {});
  const [emailResult] = await Promise.allSettled([
    (async () => {
      const to = await ownerEmail();
      if (!to) return; // owner email not configured yet
      await sendMail(to, `FabricFold · ${subject}`, text);
    })(),
    notifyOwnersWhatsApp(`${subject}\n${text}`),
  ]);
  if (emailResult.status === "rejected") console.error("notifyOwner (email) failed", emailResult.reason);
}
