import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffCustomerClient from "./_components/CustomerClient";

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

  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const gstOn = (cfg.settings as Record<string, unknown>)?.gstEnabled !== false;
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
        }
      : null,
    orders: student.orders.map((o) => ({ id: o.id, status: o.status, service: o.service, total: N(o.total), createdAt: o.createdAt.getTime() })),
    compensations: student.compensations.map((c) => ({ id: c.id, kind: c.kind, amount: N(c.amount), method: c.method, comment: c.comment, at: c.at.getTime() })),
    creditUses: student.creditUses.map((u) => ({ id: u.id, amount: N(u.amount), orderId: u.orderId, at: u.at.getTime() })),
    bags: student.bags.map((b) => ({ id: b.id, code: b.code, tier: b.tier, complimentary: b.complimentary, price: N(b.price), status: b.status, issuedAt: b.issuedAt.getTime() })),
  };

  return (
    <div className="screen">
      <TopBar title={student.name} sub={`ID ${student.id}`} back="/s" />
      <StaffCustomerClient
        student={plain}
        staffRole={staff.role}
        plans={collegePlans}
        rates={cfg.rates as Record<string, { label: string; items: [string, number][] }>}
        gstEnabled={gstOn}
      />
    </div>
  );
}
