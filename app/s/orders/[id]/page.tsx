import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffOrderClient from "./_components/OrderClient";

export default async function StaffOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const s = await getSession();
  if (!s || s.mode !== "staff") redirect("/login");
  const staff = await db.staff.findUnique({ where: { id: s.staffId } });
  if (!staff) redirect("/login");

  const order = await db.order.findUnique({
    where: { id },
    include: {
      student: { include: { subscription: true } },
      college: true,
      payments: true,
      invoice: true,
      timeline: { orderBy: { at: "asc" } },
      tags: true,
    },
  });
  if (!order) notFound();

  const cfg = await db.appConfig.findUniqueOrThrow({ where: { id: "main" } });
  const rates = cfg.rates as Record<string, { label: string; items: [string, number][] }>;
  const serviceRates = rates[order.service] || { label: order.service, items: [] };
  const payment = cfg.payment as { upiId?: string; payeeName?: string };
  const pickupOtp = await db.otp.findFirst({ where: { purpose: "pickup", refId: order.id, usedAt: null } });

  const N = (x: unknown) => Number(x || 0);
  const plain = {
    id: order.id,
    studentId: order.studentId,
    collegeId: order.collegeId,
    status: order.status,
    service: order.service,
    items: (order.items as unknown as { label: string; rate: number; qty: number }[]) || [],
    actualPieces: order.actualPieces,
    declaredPieces: order.declaredPieces,
    weightKg: order.weightKg == null ? null : N(order.weightKg),
    express: order.express,
    surcharge: N(order.surcharge),
    subtotal: N(order.subtotal),
    gst: N(order.gst),
    gstPct: N(order.gstPctSnapshot),
    total: N(order.total),
    paid: order.paid,
    paymentMethod: order.paymentMethod,
    creditApplied: N(order.creditApplied),
    usedCycle: order.usedCycle,
    noGst: order.noGst,
    intakePhotos: Array.isArray(order.intakePhotos) ? (order.intakePhotos as string[]) : [],
    refunded: order.refunded,
    refundAmount: N(order.refundAmount),
    redoOfId: order.redoOfId,
    rating: order.rating,
    ratingComment: order.ratingComment,
    createdAt: order.createdAt.getTime(),
    receivedAt: order.receivedAt ? order.receivedAt.getTime() : null,
    timeline: order.timeline.map((t) => ({ status: t.status, at: t.at.getTime() })),
    tags: order.tags.map((t) => ({ code: t.code, label: t.label, scanned: t.scanned })),
    received: order.payments.filter((p) => N(p.amount) > 0 && p.method !== "refund").reduce((s2, p) => s2 + N(p.amount), 0),
    student: {
      id: order.student.id,
      name: order.student.name,
      phone: order.student.phone,
      credits: N(order.student.credits),
      lifetimePieces: order.student.lifetimePieces,
      subscription: order.student.subscription
        ? {
            active: order.student.subscription.active,
            cyclesTotal: order.student.subscription.cyclesTotal,
            cyclesUsed: order.student.subscription.cyclesUsed,
            kgPerCycle: N(order.student.subscription.kgPerCycle),
          }
        : null,
    },
    college: order.college ? { id: order.college.id, name: order.college.name } : null,
    invoice: order.invoice ? { number: order.invoice.number } : null,
  };

  return (
    <div className="screen">
      <TopBar title={`Order ${order.id.slice(-4)}`} sub={serviceRates.label} back="/s" />
      <StaffOrderClient
        order={plain}
        serviceRates={serviceRates}
        staffRole={staff.role}
        upi={{ upiId: payment.upiId || "", payeeName: payment.payeeName || "FabricFold" }}
        expectedPickupCode={pickupOtp?.code || null}
      />
    </div>
  );
}
