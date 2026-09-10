/* SSE realtime stream. Customer subscribes to student:{id};
   staff subscribe to orders:{collegeId} for every active college. */
import { liveSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { bus, type RtEvent } from "@/lib/realtime";

export const dynamic = "force-dynamic";

export async function GET() {
  /* Found 2026-09-05: this used bare getSession(), which only checks that
     the cookie is validly SIGNED — not that the account behind it can still
     sign in. Every other protected route re-derives active/epoch status
     from the DATABASE on every request (requireStaff/requireStudent), so a
     deactivated staff member or a "sign out everywhere" is locked out
     immediately, mid-session, not whenever their token happens to expire.
     This route skipped that check entirely: a fired staff member, or a
     student/staff member who explicitly killed their other sessions after
     a lost phone, could keep an already-open SSE connection alive and go
     on receiving live order/payment/complaint events for their campus
     indefinitely, with no way to revoke it short of the connection
     dropping on its own. liveSession() is exactly requireStaff/
     requireStudent's revocation check, wrapped to return null instead of
     throwing — the fit this route always needed. */
  const s = await liveSession();
  if (!s) return new Response("unauthorized", { status: 401 });

  let channels: string[] = [];
  if (s.mode === "customer") channels = [`student:${s.studentId}`];
  else {
    // A campus-scoped staffer subscribed to every active college's channel
    // regardless of their own — a continuous live feed of another campus's
    // order/complaint/payment activity (ids, mostly, but real-time metadata
    // a scoped role should never see). Owner (collegeId null) still gets all.
    const staff = await db.staff.findUnique({ where: { id: s.staffId }, select: { collegeId: true } });
    const colleges = await db.college.findMany({
      where: { active: true, ...(staff?.collegeId ? { id: staff.collegeId } : {}) },
      select: { id: true },
    });
    channels = colleges.map((c) => `orders:${c.id}`);
  }

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (ev: RtEvent) => {
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch { /* closed */ }
      };
      const ping = setInterval(() => {
        try { controller.enqueue(enc.encode(": ping\n\n")); } catch { /* closed */ }
      }, 25_000);
      channels.forEach((ch) => bus.on(ch, send));
      controller.enqueue(enc.encode("retry: 2000\n\n"));
      (controller as unknown as { _cleanup?: () => void })._cleanup = () => {
        clearInterval(ping);
        channels.forEach((ch) => bus.off(ch, send));
      };
    },
    cancel() {
      const c = this as unknown as { _cleanup?: () => void };
      c._cleanup?.();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
