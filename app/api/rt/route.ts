/* SSE realtime stream. Customer subscribes to student:{id};
   staff subscribe to orders:{collegeId} for every active college. */
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { bus, type RtEvent } from "@/lib/realtime";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getSession();
  if (!s) return new Response("unauthorized", { status: 401 });

  let channels: string[] = [];
  if (s.mode === "customer") channels = [`student:${s.studentId}`];
  else {
    const colleges = await db.college.findMany({ where: { active: true }, select: { id: true } });
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
