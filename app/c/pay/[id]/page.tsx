import { requireStudent } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import { fmt } from "@/lib/format";
import { notFound } from "next/navigation";
import PayClient from "./_components/PayClient";

export default async function PayPage({ params }: { params: Promise<{ id: string }> }) {
  const student = await requireStudent();
  const { id } = await params;

  const order = await db.order.findUnique({ where: { id } });
  if (!order || order.studentId !== student.id) {
    notFound();
  }

  const appConfig = await db.appConfig.findUnique({ where: { id: "main" } });
  const rateLabel = (appConfig?.rates as unknown as Record<string, { label: string }>)?.[order.service]?.label || order.service;
  const payment = appConfig?.payment as unknown as { upiId: string; payeeName: string };

  return (
    <div className="screen">
      <TopBar title="Pay bill" sub={order.id.slice(-4)} back={`/c/orders/${order.id}`} />

      <div className="pad">
        <PayClient
          orderId={order.id}
          orderTotal={Number(order.total)}
          orderService={rateLabel}
          orderPieces={order.items as unknown as Array<{ qty: number }>}
          studentCredits={Number(student.credits)}
          paymentUpiId={payment?.upiId || ""}
          paymentPayeeName={payment?.payeeName || "FabricFold"}
          gatewayEnabled={!!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET)}
          testPay={process.env.TEST_TOOLS === "on"}
        />
      </div>
    </div>
  );
}
