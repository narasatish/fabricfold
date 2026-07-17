/* Self-reported crash capture. The client error boundary POSTs here; we log
   it to the DB and email the owner (deduped: at most one email per distinct
   message per hour) so production failures never go unnoticed. */
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { notifyOwner } from "@/lib/mail";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: { message?: string; stack?: string; url?: string; kind?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("bad body", { status: 400 });
  }
  const message = String(body.message || "Unknown error").slice(0, 500);
  const stack = body.stack ? String(body.stack).slice(0, 4000) : null;
  const url = body.url ? String(body.url).slice(0, 500) : null;
  const kind = body.kind === "server" ? "server" : "client";

  const s = await getSession().catch(() => null);
  const who = s ? (s.mode === "staff" ? `staff:${s.staffId}` : `student:${s.studentId}`) : null;

  await db.errorLog.create({ data: { kind, message, stack, url, who } });

  // dedupe owner email: only if this message wasn't already reported in the last hour
  const recent = await db.errorLog.count({ where: { message, at: { gte: new Date(Date.now() - 3600_000) } } });
  if (recent <= 1) {
    void notifyOwner(`App error — ${message.slice(0, 60)}`, `${kind} error at ${url || "?"}\n\n${message}\n\n${stack || ""}`.slice(0, 1500));
  }
  return Response.json({ ok: true });
}
