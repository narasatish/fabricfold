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

/* Returns whether the mail actually went somewhere real. Found 2026-10-22:
   every caller treated a `sendMail` call as having succeeded once it
   returned — `console.error` on a non-OK response is invisible on a
   serverless host, and error-digest's own route comment ("a send failure
   means the next run reports them again") was never true, because this
   function never communicated failure to begin with. The console-log
   dev-mode fallback (no RESEND_API_KEY) still counts as success — that's
   the intended behavior when email isn't configured yet, not a failure. */
export async function sendMail(to: string, subject: string, text: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log(`[MAIL -> ${to}] ${subject}\n${text}`);
    return true;
  }
  try {
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
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("mail send failed", res.status, detail);
      await db.errorLog.create({ data: { kind: "client", message: `Mail send failed (${res.status}): ${detail}`.slice(0, 2000) } }).catch(() => {});
      return false;
    }
    return true;
  } catch (e) {
    console.error("mail send threw", e);
    await db.errorLog.create({ data: { kind: "client", message: `Mail send threw: ${e instanceof Error ? e.message : String(e)}`.slice(0, 2000) } }).catch(() => {});
    return false;
  }
}

/* Owner WhatsApp alerts are limited to the few events owners asked for: new
   registrations, complaints, orders placed, orders collected (delivered) and
   walk-in orders. Everything else stays email-only. Daily collections are sent
   by the daily report cron, not through here. */
const WA_ALERT = /^(New student registered|New BVRIT registration|New complaint|New order #|Walk-in order #|Order collected #)/;

/** Notify the owner about a business event — email, instant WhatsApp
    (Admin -> Settings -> alert phone numbers), AND a web push straight to
    every Owner-role staff member's own signed-in device, independently of
    each other: email being unconfigured must not silently skip WhatsApp or
    push, or vice versa. Never throws.

    The push channel was added 2026-10-22 specifically for redundancy: it's
    the one channel that doesn't depend on a third party staying configured
    and healthy (Resend, Meta's WhatsApp billing — which was itself found
    broken this same day) — web push already works today for every signed-in
    student, the infrastructure (PushSubscription, sendPushTo) just never had
    an owner-facing caller. It's best-effort like the other two: a device
    that never subscribed gets nothing from this channel, same as an owner
    who never set a report email gets nothing from that one.

    Returns true if AT LEAST ONE channel plausibly delivered — callers like
    error-digest use this to decide whether it's safe to mark something as
    "the owner has now been told", rather than assuming success unconditionally
    the way every caller here used to. */
export async function notifyOwner(subject: string, text: string): Promise<boolean> {
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
  const [emailResult, , pushResult] = await Promise.allSettled([
    (async () => {
      const to = await ownerEmail();
      if (!to) return false; // owner email not configured yet
      return sendMail(to, `FabricFold · ${subject}`, text);
    })(),
    WA_ALERT.test(subject) ? notifyOwnersWhatsApp(`${subject}
${text}`) : Promise.resolve(),
    (async () => {
      const { sendPushTo } = await import("./push");
      const owners = await db.staff.findMany({ where: { role: 4, active: true }, select: { id: true } });
      const counts = await Promise.all(
        owners.map((o) => sendPushTo("staff", o.id, { title: `FabricFold · ${subject}`, body: text.slice(0, 180) }).catch(() => 0)),
      );
      return counts.some((n) => n > 0);
    })(),
  ]);
  if (emailResult.status === "rejected") console.error("notifyOwner (email) failed", emailResult.reason);
  const emailOk = emailResult.status === "fulfilled" && emailResult.value === true;
  const pushOk = pushResult.status === "fulfilled" && pushResult.value === true;
  return emailOk || pushOk;
}
