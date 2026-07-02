import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";

export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return new Response("unauthorized", { status: 401 });
  const sub = await req.json();
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return new Response("bad subscription", { status: 400 });
  const userKind = s.mode === "customer" ? "student" : "staff";
  const userId = s.mode === "customer" ? s.studentId : s.staffId;
  await db.pushSubscription.upsert({
    where: { endpoint: sub.endpoint },
    create: { userKind, userId, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    update: { userKind, userId, p256dh: sub.keys.p256dh, auth: sub.keys.auth },
  });
  return Response.json({ ok: true });
}
