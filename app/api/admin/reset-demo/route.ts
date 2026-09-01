/* ONE-OFF: wipe demo data for launch. REMOVE THIS ROUTE AFTER USE.

   Owner-ordered (Sep 2026): clear every transactional row — orders, payments,
   invoices, subscriptions, bags, complaints, the lot — and keep only the four
   real people. The ledger delete-protection triggers are deliberately in the
   way; they are lowered with the same escape hatch a restore uses
   (app.allow_delete), inside the transaction, so protection is back the
   moment it commits.

   Guarded three ways: Owner session, an explicit confirm phrase, and the
   route's own removal after the single run — a standing wipe endpoint is not
   something a production app should carry. */
import { db } from "@/lib/db";
import { requireStaff } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const KEEP = {
  // staff: phone → { name, role }
  staff: {
    "8019121966": { name: "Satish", role: 4 },
    "9381232723": { name: "Yogesh", role: 4 },
    "6390231501": { name: "Arjun", role: 1 },
    "8264924057": { name: "Abhishek", role: 1 },
  } as Record<string, { name: string; role: number }>,
  // student accounts that survive (fresh: no credits, no plan, no history)
  students: { "8019121966": "Satish", "9381232723": "Yogesh", "8264924057": "Abhishek" } as Record<string, string>,
};

export async function POST(req: Request) {
  let owner;
  try {
    owner = await requireStaff(4);
  } catch {
    return new Response("unauthorized", { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  if (body.confirm !== "WIPE DEMO DATA") {
    return Response.json({ ok: false, error: 'POST {"confirm":"WIPE DEMO DATA"} to run — this deletes every order and payment.' }, { status: 400 });
  }

  const wiped: Record<string, number> = {};
  await db.$transaction(async (tx) => {
    // Lower the ledger triggers for THIS transaction only.
    await tx.$executeRawUnsafe(`SELECT set_config('app.allow_delete', 'on', true)`);

    /* Children before parents. Everything transactional goes — including the
       kept people's test orders: the owner asked for a clean slate, and a
       half-history that mixes demo money with real money is worse than none. */
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
      ["payslip", () => tx.payslip.deleteMany({})],
      ["expense", () => tx.expense.deleteMany({})],
      ["attendance", () => tx.attendance.deleteMany({})],
      ["dayClose", () => tx.dayClose.deleteMany({})],
      ["sheetOutbox", () => tx.sheetOutbox.deleteMany({})],
      ["waVerify", () => tx.waVerify.deleteMany({})],
      ["rateLimit", () => tx.rateLimit.deleteMany({})],
      ["errorLog", () => tx.errorLog.deleteMany({})],
      ["otp", () => tx.otp.deleteMany({})],
      ["pushSubscription", () => tx.pushSubscription.deleteMany({})],
      ["auditLog", () => tx.auditLog.deleteMany({})],
      /* Sequences reset WITH the ledgers they number: the invoices are gone,
         so INV-<FY>-0001 must be mintable again — a gap-free series that
         starts at 47 for no visible reason fails its own audit. Bag codes
         re-mint from 1000, and the import bumps them past printed stock. */
      ["fySequence", () => tx.fySequence.deleteMany({})],
    ];
    for (const [name, fn] of order) wiped[name] = (await fn()).count;

    // Students: keep only the named numbers, reset to a fresh state.
    const keepPhones = Object.keys(KEEP.students);
    wiped.student = (await tx.student.deleteMany({ where: { phone: { notIn: keepPhones } } })).count;
    const stMarys = await tx.college.findFirst({ where: { name: { contains: "St Mary" } } });
    for (const [phone, name] of Object.entries(KEEP.students)) {
      await tx.student.updateMany({
        where: { phone },
        data: {
          name, credits: 0, lifetimePieces: 0, washDay: null, anonymisedAt: null,
          ...(stMarys ? { collegeId: stMarys.id } : {}), // nobody stays on removed BVRIT
        },
      });
    }

    // Staff: the named four, exactly. Demo staff go entirely (their payroll
    // and attendance rows were wiped above, so a hard delete is clean).
    const staffPhones = Object.keys(KEEP.staff);
    wiped.staff = (await tx.staff.deleteMany({ where: { phone: { notIn: staffPhones } } })).count;
    for (const [phone, s] of Object.entries(KEEP.staff)) {
      const existing = await tx.staff.findUnique({ where: { phone } });
      if (existing) {
        await tx.staff.update({ where: { phone }, data: { name: s.name, role: s.role, active: true, sessionEpoch: { increment: 1 } } });
      } else {
        await tx.staff.create({ data: { phone, name: s.name, role: s.role, collegeId: null } });
      }
    }

    await tx.auditLog.create({
      data: { action: "Demo data wiped", detail: `Launch reset by ${owner.name}: kept ${staffPhones.length} staff, ${keepPhones.length} customer accounts`, by: owner.id },
    });
  }, { timeout: 45_000 });

  const left = {
    students: await db.student.count(),
    staff: await db.staff.findMany({ select: { name: true, phone: true, role: true, active: true } }),
    orders: await db.order.count(),
    payments: await db.payment.count(),
  };
  return Response.json({ ok: true, wiped, left });
}
