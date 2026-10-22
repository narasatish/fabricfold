import webpush from "web-push";
import { db } from "./db";

/* A push send failure used to only reach the function's own `catch` with no
   trace left anywhere — not even console.error — unless it was a 404/410
   (a dead subscription, correctly deleted and never worth logging). Every
   OTHER failure (an expired VAPID key, a push service outage, a malformed
   payload) was completely invisible: no console output, no ErrorLog row,
   nothing in the Admin App Errors panel. lib/notify.ts's sendWhatsApp/
   waPost already learned this exact lesson for WhatsApp on 2026-10-01
   ("a failed send used to only reach console.error, which nobody reviews
   on Vercel serverless") — that fix was never carried over to Web Push,
   the channel pushNotif() actually calls for every student notification.
   Logging it the same way closes that gap; best-effort, never throws. */
async function logPushFailure(message: string) {
  try {
    await db.errorLog.create({ data: { kind: "client", message: `Push: ${message}`.slice(0, 2000) } });
  } catch { /* logging is best-effort */ }
}

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:support@fabricfold.in", pub, priv);
  configured = true;
  return true;
}

/** Returns how many of this user's devices actually received the push — 0
    isn't an error (no subscriptions, or every send failed), just an honest
    count a caller can use to decide whether this channel came through.
    Added 2026-10-22 for notifyOwner's redundancy check: the function never
    threw on a real failure (by design, a push outage shouldn't break the
    caller), so a caller previously had no way to tell "delivered" from
    "silently did nothing" — both looked like a clean resolve. */
export async function sendPushTo(userKind: "student" | "staff", userId: string, payload: { title: string; body: string }): Promise<number> {
  if (!ensureConfigured()) return 0;
  const subs = await db.pushSubscription.findMany({ where: { userKind, userId } });
  const results = await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
        return true;
      } catch (e: unknown) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await db.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
        } else {
          console.error("Web push send failed", status, e);
          await logPushFailure(`send failed (${status ?? "no status"}) ${e instanceof Error ? e.message : String(e)}`);
        }
        return false;
      }
    }),
  );
  return results.filter((r) => r.status === "fulfilled" && r.value === true).length;
}
