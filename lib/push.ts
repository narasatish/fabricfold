import webpush from "web-push";
import { db } from "./db";

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:support@fabricfold.in", pub, priv);
  configured = true;
  return true;
}

export async function sendPushTo(userKind: "student" | "staff", userId: string, payload: { title: string; body: string }) {
  if (!ensureConfigured()) return;
  const subs = await db.pushSubscription.findMany({ where: { userKind, userId } });
  await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload));
      } catch (e: unknown) {
        const status = (e as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await db.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
      }
    }),
  );
}
