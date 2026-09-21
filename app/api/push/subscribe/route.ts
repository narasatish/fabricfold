import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { isPushEndpoint } from "@/lib/push-validation";

export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return new Response("unauthorized", { status: 401 });
  let sub;
  try {
    sub = await req.json();
  } catch {
    return new Response("bad subscription", { status: 400 });
  }
  const p256dh = sub?.keys?.p256dh, auth = sub?.keys?.auth;
  // The server later POSTs to this URL, so it must be a real browser push
  // service — see lib/push-validation.ts. Key lengths are capped too.
  if (!isPushEndpoint(sub?.endpoint) || typeof p256dh !== "string" || typeof auth !== "string" || !p256dh || !auth || p256dh.length > 200 || auth.length > 100) {
    return new Response("bad subscription", { status: 400 });
  }
  const userKind = s.mode === "customer" ? "student" : "staff";
  const userId = s.mode === "customer" ? s.studentId : s.staffId;
  await db.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: { userKind, userId, endpoint: sub.endpoint, p256dh, auth },
    update: { userKind, userId, p256dh, auth },
  });
  return Response.json({ ok: true });
}
