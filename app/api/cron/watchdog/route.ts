/* Fast, frequent early-warning for the Owner — runs every 5 minutes, unlike
   the daily error-digest (app/api/cron/error-digest/route.ts), which is a
   once-a-day rollup nobody reads until morning. A server-side error at 2am
   affecting real students should not wait until the 6am digest to surface.

   Deliberately narrow: only genuinely actionable signals, so this never
   trains the Owner to ignore it.
     1. Any NEW "server" kind ErrorLog rows since the last run — a real
        exception somewhere in the app, not a client-side browser quirk.
     2. The database itself being unreachable — the errorLog query above
        already proves connectivity when it succeeds; this path is what
        fires when it does not.

   Marks alerted rows `seen`, the same field error-digest already uses — so
   a batch this route already reported is not reported again at 6am; the
   digest becomes a "nothing new happened overnight" reassurance rather than
   a duplicate alarm, and still catches anything this route somehow missed
   (a mail-send failure here leaves rows unseen for the digest to pick up).

   Runs on Render's cron scheduler (render.yaml), or Owner-triggered. */
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { notifyOwner } from "@/lib/mail";
import { isCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_DETAIL_LINES = 10;

async function authorised(req: Request) {
  if (isCronRequest(req)) return true;
  const s = await getSession().catch(() => null);
  if (!s || s.mode !== "staff") return false;
  const st = await db.staff.findUnique({ where: { id: s.staffId } });
  return !!st && st.role >= 4; // Owner only
}

export async function GET(req: Request) {
  if (!(await authorised(req))) return new Response("unauthorized", { status: 401 });

  let unseen;
  try {
    unseen = await db.errorLog.findMany({
      where: { seen: false, kind: "server" },
      orderBy: { at: "desc" },
      take: 300,
    });
  } catch (e) {
    // The query itself failing (not a business "no rows") means the database
    // is unreachable — the single most urgent thing this route can report,
    // and the one case error-digest structurally cannot catch, since IT
    // needs the same query to succeed to run at all.
    await notifyOwner(
      "🚨 Database unreachable",
      `The watchdog's own ErrorLog query failed:\n\n${(e as Error).message}\n\nThis means the app likely cannot serve ANY request right now. Check the Render dashboard immediately.`,
    ).catch(() => {});
    return Response.json({ ok: false, error: "db unreachable" }, { status: 200 }); // 200: the alert already fired; a 5xx here would just make Render's own cron-failure log noisier for no benefit
  }

  if (!unseen.length) return Response.json({ ok: true, errors: 0, sent: false });

  const groups = new Map<string, { count: number; url: string | null; last: Date }>();
  for (const e of unseen) {
    const key = e.message.slice(0, 160);
    const g = groups.get(key);
    if (g) { g.count++; if (e.at > g.last) g.last = e.at; }
    else groups.set(key, { count: 1, url: e.url, last: e.at });
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
  const lines = ranked.slice(0, MAX_DETAIL_LINES).map(([msg, g]) =>
    `${String(g.count).padStart(3)}x  ${msg}${g.url ? `\n         at ${g.url}` : ""}`,
  );
  if (ranked.length > MAX_DETAIL_LINES) lines.push(`\n…and ${ranked.length - MAX_DETAIL_LINES} more distinct error(s).`);

  const body = [
    `${unseen.length} server error(s) in the last few minutes, ${ranked.length} distinct.`,
    "",
    ...lines,
    "",
    "Full detail: fabricfold.in/s/admin (App errors).",
  ].join("\n");

  await notifyOwner(`🚨 ${unseen.length} live server error(s)`, body);
  await db.errorLog.updateMany({ where: { id: { in: unseen.map((e) => e.id) } }, data: { seen: true } });

  return Response.json({ ok: true, errors: unseen.length, distinct: ranked.length, sent: true });
}
