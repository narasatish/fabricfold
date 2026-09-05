import { requireStudent } from "@/lib/auth";
import { db } from "@/lib/db";
import OrdersClient from "./_components/OrdersClient";

export default async function OrdersPage() {
  const student = await requireStudent();
  const allOrders = await db.order.findMany({
    where: { studentId: student.id },
    orderBy: { createdAt: "desc" },
  });

  const appConfig = await db.appConfig.findUnique({ where: { id: "main" } });
  const rates = appConfig?.rates as unknown as Record<string, { label: string }>;

  // Convert to a plain, serializable shape (Decimal fields -> number)
  const orders = allOrders.map((o) => ({
    ...o,
    total: Number(o.total),
    subtotal: Number(o.subtotal),
    gst: Number(o.gst),
    surcharge: Number(o.surcharge),
    weightKg: o.weightKg == null ? null : Number(o.weightKg),
    gstPctSnapshot: Number(o.gstPctSnapshot),
    creditApplied: Number(o.creditApplied),
    refundAmount: o.refundAmount == null ? null : Number(o.refundAmount),
  }));

  return (
    <div className="screen">
      <OrdersClient orders={orders as any} rates={rates} />
    </div>
  );
}
