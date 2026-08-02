/* Photo retention sweep.

   Intake and complaint photos are dispute evidence, but only for as long as a
   dispute is realistically live. After PHOTO_RETENTION_DAYS the image files are
   deleted from storage and the keys cleared from the rows that referenced them,
   so storage doesn't grow without bound for the life of the business.

   The rows themselves stay — an order and its complaint thread are permanent
   records. Only the heavy binaries go.

   Runs on the daily Vercel cron, or Owner-triggered. */
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { Prisma } from "@/lib/generated/prisma/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const PHOTO_RETENTION_DAYS = Number(process.env.PHOTO_RETENTION_DAYS || 30);

async function authorised(req: Request) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  const s = await getSession().catch(() => null);
  if (!s || s.mode !== "staff") return false;
  const st = await db.staff.findUnique({ where: { id: s.staffId } });
  return !!st && st.role >= 4; // Owner only
}

/** Delete one object from Supabase storage. Missing is treated as success —
    the goal is "this file is gone", and it already is. */
async function deleteObject(key: string) {
  const supaUrl = process.env.SUPABASE_URL, supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!supaUrl || !supaKey || key.startsWith("local/")) return false;
  const bucket = process.env.SUPABASE_BUCKET || "receipts";
  const res = await fetch(`${supaUrl}/storage/v1/object/${bucket}/${encodeURI(key)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${supaKey}`, apikey: supaKey },
  });
  return res.ok || res.status === 404;
}

function keysOf(v: unknown): string[] {
  return Array.isArray(v) ? v.map((k) => String(k || "").trim()).filter(Boolean) : [];
}

export async function GET(req: Request) {
  if (!(await authorised(req))) return new Response("unauthorized", { status: 401 });

  const cutoff = new Date(Date.now() - PHOTO_RETENTION_DAYS * 86_400_000);
  let deleted = 0, failed = 0, orders = 0, messages = 0;

  try {
    // Intake photos on old orders
    const oldOrders = await db.order.findMany({
      where: { createdAt: { lt: cutoff }, intakePhotos: { not: Prisma.DbNull } },
      select: { id: true, intakePhotos: true },
      take: 500,
    });
    for (const o of oldOrders) {
      const keys = keysOf(o.intakePhotos);
      if (!keys.length) continue;
      for (const k of keys) ((await deleteObject(k)) ? deleted++ : failed++);
      // DbNull, not undefined — undefined would mean "leave this column alone"
      await db.order.update({ where: { id: o.id }, data: { intakePhotos: Prisma.DbNull } });
      orders++;
    }

    // Photos attached to old complaint messages
    const oldMsgs = await db.complaintMessage.findMany({
      where: { at: { lt: cutoff }, photos: { not: Prisma.DbNull } },
      select: { id: true, photos: true },
      take: 500,
    });
    for (const m of oldMsgs) {
      const keys = keysOf(m.photos);
      if (!keys.length) continue;
      for (const k of keys) ((await deleteObject(k)) ? deleted++ : failed++);
      await db.complaintMessage.update({ where: { id: m.id }, data: { photos: Prisma.DbNull } });
      messages++;
    }
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message, deleted, failed }, { status: 500 });
  }

  return Response.json({ ok: true, retentionDays: PHOTO_RETENTION_DAYS, orders, messages, deleted, failed });
}
