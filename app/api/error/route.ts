/* Self-reported crash capture. The client error boundary POSTs here; we log
   it to the DB and email the owner (deduped: at most one email per distinct
   message per hour) so production failures never go unnoticed. */
import { db } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { notifyOwner } from "@/lib/mail";
import { rateLimit, requestIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/* Found 2026-09-05: this is a public, UNAUTHENTICATED endpoint (client error
   boundaries report from pages where nobody may be signed in yet, e.g.
   /login) with no rate limit at all — not even the per-message email dedup
   below actually stops abuse, since it dedupes on exact message TEXT: an
   attacker varying the message slightly on every call bypasses it entirely
   and can trigger unlimited notifyOwner() emails, or just bloat ErrorLog
   indefinitely. This codebase already treats email/SMS-bombing as a real,
   named threat (see requestOtp's own rate limiting, and the earlier fix to
   the rate limiter's own race) — this endpoint never got the same
   treatment despite being reachable by anyone, signed in or not. */
const ERROR_MAX_PER_IP_HOUR = 60;

export async function POST(req: Request) {
  const ip = await requestIp();
  if (ip !== "unknown") {
    const lim = await rateLimit(`error-report:ip:${ip}`, ERROR_MAX_PER_IP_HOUR, 3600);
    if (!lim.allowed) return new Response("too many reports", { status: 429 });
  }

  let body: { message?: string; stack?: string; url?: string; kind?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("bad body", { status: 400 });
  }
  const message = String(body.message || "Unknown error").slice(0, 500);
  const stack = body.stack ? String(body.stack).slice(0, 4000) : null;
  const url = body.url ? String(body.url).slice(0, 500) : null;
  /* Found live 2026-09-17: this is a public, unauthenticated endpoint, and
     `kind` used to come straight from the client-submitted body — trusting
     it as "server" whenever the caller claimed so. Every real caller
     (components/error-reporter.tsx, the only place in this codebase that
     POSTs here) always sends kind:"client"; a genuine server-side error is
     logged directly via db.errorLog.create() from trusted server code
     (e.g. notify.ts's logWaFailure), never through this HTTP route. So a
     "server" claim arriving here has no legitimate source — only an
     attacker forging the field. That distinction now matters more than it
     used to: the new fast watchdog (app/api/cron/watchdog/route.ts) alerts
     the Owner immediately on any unseen kind:"server" row, so trusting the
     client here let anyone spam urgent "production is broken" alerts, or
     just bloat ErrorLog, from an endpoint that needs no session at all.
     This route can only ever ATTEST to a client-side error, so it forces
     that regardless of what the caller sends. */
  const kind = "client" as const;

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
