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

/* Owner WhatsApp alerts are limited to the few events owners asked for: new
   registrations, complaints, orders placed, orders collected (delivered) and
   walk-in orders. Everything else stays email-only. Daily collections are sent
   by the daily report cron, not through here. */
const WA_ALERT = /^(New student registered|New BVRIT registration|New complaint|New order #|Walk-in order #|Order collected #)/;

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
     WhatsApp code anyone has been looking at so far.

     kind MUST be "client", not "server": cron-watchdog's own alert-about-
     errors call is itself a notifyOwner() call, so a "server"-kind row
     here would self-trigger on every watchdog alert it ever sends — the
     NEW row lands after the watchdog's own `unseen` snapshot was already
     taken, so its own `updateMany` never marks it seen, and the NEXT
     watchdog run (5 min later) finds it, alerts again, and spawns another
     one — an alert storm that never goes quiet, confirmed by a real test
     failure (cron-watchdog-behavioral.test.ts) the moment this shipped.
     The Admin App Errors panel has no kind filter, so "client" still
     shows there; only the "server"-only watchdog/digest crons ignore it,
     exactly like any other client-side noise. */
  const [emailResult] = await Promise.allSettled([
    (async () => {
      const to = await ownerEmail();
      if (!to) return; // owner email not configured yet
      await sendMail(to, `FabricFold · ${subject}`, text);
    })(),
    WA_ALERT.test(subject) ? notifyOwnersWhatsApp(`${subject}
${text}`) : Promise.resolve(),
  ]);
  if (emailResult.status === "rejected") console.error("notifyOwner (email) failed", emailResult.reason);
}
