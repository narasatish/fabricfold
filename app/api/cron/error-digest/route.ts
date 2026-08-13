/* Tell the Owner when things break.

   Errors were already being recorded in ErrorLog — but nobody was ever told,
   so the only way to learn something was broken was for a student to complain.
   A log nobody reads is not monitoring.

   Sends a digest of unseen errors, grouped by message so one recurring fault
   is a single line with a count rather than two hundred emails. Marks them
   seen afterwards, so each error is reported once.

   Runs on the daily cron, or Owner-triggered. */
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { notifyOwner } from "@/lib/mail";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* Beyond this many in one window, the detail stops helping and the fact that
   it is happening at all is the message. */
const MAX_DETAIL_LINES = 15;

async function authorised(req: Request) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth === `Bearer ${process.env.CRON_SECRET}`) return true;
  const s = await getSession().catch(() => null);
  if (!s || s.mode !== "staff") return false;
  const st = await db.staff.findUnique({ where: { id: s.staffId } });
  return !!st && st.role >= 4; // Owner only
}

export async function GET(req: Request) {
  if (!(await authorised(req))) return new Response("unauthorized", { status: 401 });

  const unseen = await db.errorLog.findMany({
    where: { seen: false },
    orderBy: { at: "desc" },
    take: 500,
  });

  if (!unseen.length) return Response.json({ ok: true, errors: 0, sent: false });

  // Group by message: one recurring fault should read as "x47", not 47 lines.
  const groups = new Map<string, { count: number; kind: string; url: string | null; last: Date }>();
  for (const e of unseen) {
    const key = e.message.slice(0, 160);
    const g = groups.get(key);
    if (g) { g.count++; if (e.at > g.last) g.last = e.at; }
    else groups.set(key, { count: 1, kind: e.kind, url: e.url, last: e.at });
  }

  const ranked = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  const lines = ranked.slice(0, MAX_DETAIL_LINES).map(([msg, g]) =>
    `${String(g.count).padStart(3)}x  [${g.kind}] ${msg}${g.url ? `\n         at ${g.url}` : ""}`,
  );
  if (ranked.length > MAX_DETAIL_LINES) {
    lines.push(`\n…and ${ranked.length - MAX_DETAIL_LINES} more distinct error(s).`);
  }

  const body = [
    `${unseen.length} error(s) recorded since the last digest, ${ranked.length} distinct.`,
    "",
    ...lines,
    "",
    "Full detail: fabricfold.in/s/admin (App errors).",
  ].join("\n");

  await notifyOwner(`FabricFold: ${unseen.length} app error(s)`, body);

  // Mark seen only AFTER the mail is away, so a send failure means the next
  // run reports them again rather than losing them silently.
  await db.errorLog.updateMany({ where: { id: { in: unseen.map((e) => e.id) } }, data: { seen: true } });

  return Response.json({ ok: true, errors: unseen.length, distinct: ranked.length, sent: true });
}
