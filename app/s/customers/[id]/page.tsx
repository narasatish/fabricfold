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
    },
  });
  if (!student) notFound();

  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const planCfg = cfg.plan as { price: number; cycles: number; kgPerCycle: number };
  const planGross = planCfg.price + Math.round(planCfg.price * Number(cfg.gstPct) / 100);

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
  };

  return (
    <div className="screen">
      <TopBar title={student.name} sub={`ID ${student.id}`} back="/s" />
      <StaffCustomerClient student={plain} staffRole={staff.role} plan={{ ...planCfg, gross: planGross }} />
    </div>
  );
}
