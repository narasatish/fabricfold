import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffCustomerClient from "./_components/CustomerClient";
import { resolveCollegeRates, type RateTable } from "@/lib/money";

export default async function StaffCustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect("/login");
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");

  const student = await db.student.findUnique({
    where: { id },
    include: {
      college: true,
      subscription: { include: { cycleLog: { orderBy: { at: "desc" } } } },
      orders: { orderBy: { createdAt: "desc" } },
      compensations: { orderBy: { at: "desc" } },
      creditUses: { orderBy: { at: "desc" } },
      bags: { orderBy: { issuedAt: "desc" } },
    },
  });
  if (!student) notFound();
  /* This page builds its own query rather than going through a server action,
     so the assertSameCollege() safety net every action already has doesn't
     apply here automatically — it must be checked explicitly, the same way,
     right after the row is loaded. Without it, any authenticated staff member
     could view any other campus's student in full (name, phone, credits,
     every order, every compensation, every bag) just by knowing/guessing an
     id, regardless of their own role or campus assignment. */
  if (staff.collegeId && staff.collegeId !== student.collegeId) redirect("/s/students");

  /* The bag code (B1001/S1055/G1002...) is the CUSTOMER-FACING ID — printed
     on the physical bag, quoted at the counter. student.id is an internal
     random 6-digit row key nobody outside the database should ever see; the
     header was showing that instead, which is exactly what looked wrong. */
  const activeBag = student.bags.find((b) => b.status === "active");
  const displayId = activeBag?.code ?? student.id;

  /* Campuses a student may be moved to, plus each one's closed day so the
     edit sheet can grey out a wash day the campus does not operate. */
  const colleges = await db.college.findMany({
    where: { active: true },
    select: { id: true, name: true, closedWeekday: true },
    orderBy: { name: "asc" },
  });
  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const gstOn = (cfg.settings as Record<string, unknown>)?.gstEnabled !== false;
  /* Staff placing a walk-in order for THIS student must see THEIR college's
     rates, not the global default — otherwise a BVRIT walk-in shows St
     Mary's-style pricing on screen while the actual charge (computed
     server-side in walkInOrder, already college-aware) differs, which reads
     as the total being wrong even though it isn't. */
  const collegeRatesRow = await db.college.findUnique({ where: { id: student.collegeId }, select: { rates: true, expressRates: true } });
  const effectiveRates = resolveCollegeRates(cfg.rates as unknown as RateTable, collegeRatesRow?.rates as unknown as RateTable | null);
  const SERVICE_LABEL: Record<string, string> = { washIron: "Wash & Iron", washFold: "Wash & Fold", ironOnly: "Iron Only", dryClean: "Dry Clean" };
  const collegePlans = (await db.plan.findMany({ where: { collegeId: student.collegeId, active: true }, orderBy: { price: "asc" } })).map((p) => {
    const price = Number(p.price);
    const gstApplies = gstOn && !p.gstFree;
    return {
      id: p.id, name: p.name, tier: p.tier, price,
      gross: price + (gstApplies ? Math.round(price * Number(cfg.gstPct) / 100) : 0),
      gstApplies,
      buckets: (p.buckets as unknown as { service: string; cycles: number; kgPerCycle: number }[]).map((b) => ({ ...b, label: SERVICE_LABEL[b.service] || b.service })),
    };
  });

  const N = (x: unknown) => Number(x || 0);
  const plain = {
    id: student.id,
    name: student.name,
    kind: student.kind,
    phone: student.phone,
    credits: N(student.credits),
    lifetimePieces: student.lifetimePieces,
    createdAt: student.createdAt.getTime(),
    college: student.college ? { id: student.college.id, name: student.college.name } : null,
    subscription: student.subscription
      ? {
          active: student.subscription.active,
          plan: student.subscription.plan,
          cyclesTotal: student.subscription.cyclesTotal,
          cyclesUsed: student.subscription.cyclesUsed,
          kgPerCycle: N(student.subscription.kgPerCycle),
          expiresAt: student.subscription.expiresAt ? student.subscription.expiresAt.getTime() : null,
          cycleLog: student.subscription.cycleLog.map((c) => ({ at: c.at.getTime(), orderId: c.orderId })),
          buckets: ((student.subscription.buckets as unknown as { service: string; cycles: number; used: number; kgPerCycle: number }[] | null) ?? []).map((b) => ({ ...b, label: SERVICE_LABEL[b.service] || b.service })),
        }
      : null,
    orders: student.orders.map((o) => ({ id: o.id, status: o.status, service: o.service, total: N(o.total), createdAt: o.createdAt.getTime() })),
    compensations: student.compensations.map((c) => ({ id: c.id, kind: c.kind, amount: N(c.amount), method: c.method, comment: c.comment, at: c.at.getTime() })),
    creditUses: student.creditUses.map((u) => ({ id: u.id, amount: N(u.amount), orderId: u.orderId, at: u.at.getTime() })),
    bags: student.bags.map((b) => ({ id: b.id, code: b.code, tier: b.tier, complimentary: b.complimentary, price: N(b.price), status: b.status, issuedAt: b.issuedAt.getTime() })),
  };

  return (
    <div className="screen">
      <TopBar title={student.name} sub={`ID ${displayId}`} back="/s" />
      <StaffCustomerClient
        colleges={colleges}
        student={plain}
        staffRole={staff.role}
        plans={collegePlans}
        rates={effectiveRates}
        collegeHasRatesOverride={!!collegeRatesRow?.rates}
        collegeExpressOverride={collegeRatesRow?.expressRates as Record<string, number> | null}
        gstEnabled={gstOn}
      />
    </div>
  );
}
