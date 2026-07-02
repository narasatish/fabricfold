import { notFound, redirect } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import StaffOrderClient from "./_components/OrderClient";

export default async function StaffOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await requireStaff(1);

  const order = await db.order.findUnique({
    where: { id },
    include: {
      student: true,
      college: true,
      payments: true,
      invoice: true,
    },
  });

  if (!order) notFound();

  const rateConfig = await db.appConfig.findUnique({
    where: { id: "main" },
    select: { rates: true },
  });

  const serviceRates = (rateConfig?.rates as any)?.[order.service] || { label: order.service, items: [] };

  return (
    <div className="screen">
      <TopBar
        title={`Order ${order.id.slice(-4)}`}
        sub={serviceRates.label}
        back="/s"
      />
      <StaffOrderClient order={order} serviceRates={serviceRates} />
    </div>
  );
}
