/* ONE-OFF: clear every student account before the real Excel roster goes in.
   REMOVE THIS ROUTE AFTER USE — same three guards as the earlier launch wipe:
   Owner session, an explicit confirm phrase, and removal right after the
   single run. A standing student-wipe endpoint has no place in production.

   Also returns a read-only report on the four staff accounts, so a login
   question ("Yogesh can't get in") can be answered from real data instead
   of a guess — this endpoint is the only way to see the LIVE Mumbai Staff
   table right now; the Vercel CLI's `env pull` returns DATABASE_URL blank
   for Supabase-integration-managed variables, so it cannot be read locally. */
import { db } from "@/lib/db";
import { requireStaff } from "@/lib/auth";
import { runRosterSync } from "@/lib/sheets-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  let owner;
  try {
    owner = await requireStaff(4);
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  if (body.confirm !== "WIPE ALL STUDENTS") {
    return Response.json({ ok: false, error: 'POST {"confirm":"WIPE ALL STUDENTS"} to run — this deletes every student account.' }, { status: 400 });
  }

  const wiped: Record<string, number> = {};
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.allow_delete', 'on', true)`);
    const order: [string, () => Promise<{ count: number }>][] = [
      ["notification", () => tx.notification.deleteMany({})],
      ["complaintMessage", () => tx.complaintMessage.deleteMany({})],
      ["complaint", () => tx.complaint.deleteMany({})],
      ["garmentTag", () => tx.garmentTag.deleteMany({})],
      ["orderEvent", () => tx.orderEvent.deleteMany({})],
      ["cycleUse", () => tx.cycleUse.deleteMany({})],
      ["creditUse", () => tx.creditUse.deleteMany({})],
      ["compensation", () => tx.compensation.deleteMany({})],
      ["creditNote", () => tx.creditNote.deleteMany({})],
      ["invoice", () => tx.invoice.deleteMany({})],
      ["payment", () => tx.payment.deleteMany({})],
      ["order", () => tx.order.deleteMany({})],
      ["bag", () => tx.bag.deleteMany({})],
      ["subscription", () => tx.subscription.deleteMany({})],
      ["waVerify", () => tx.waVerify.deleteMany({})],
      ["fySequence", () => tx.fySequence.deleteMany({})], // re-mint INV/bag numbers from a clean slate
      ["student", () => tx.student.deleteMany({})],       // every account — the real roster goes in next
    ];
    for (const [name, fn] of order) wiped[name] = (await fn()).count;
    await tx.auditLog.create({
      data: { action: "All students wiped", detail: `Pre-import reset by ${owner.name}`, by: owner.id },
    });
  }, { timeout: 45_000 });

  // Refresh the Sheet immediately so it matches the now-empty roster.
  let sheetSynced = false;
  try { await runRosterSync(); sheetSynced = true; } catch { /* the app remains correct even if the Sheet write fails */ }

  const staffReport = await db.staff.findMany({
    select: { id: true, phone: true, name: true, role: true, active: true, sessionEpoch: true },
    orderBy: { role: "desc" },
  });

  return Response.json({ ok: true, wiped, sheetSynced, studentsLeft: await db.student.count(), staff: staffReport });
}
