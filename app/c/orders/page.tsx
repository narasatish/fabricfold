import { requireStudent } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import { fmt, timeAgo, dateStr, STATUS_LABEL } from "@/lib/format";
import Link from "next/link";
import { Svg } from "@/components/icons";
import OrdersClient from "./_components/OrdersClient";

export default async function OrdersPage() {
  const student = await requireStudent();
  const allOrders = await db.order.findMany({
    where: { studentId: student.id },
    orderBy: { createdAt: "desc" },
  });

  const appConfig = await db.appConfig.findUnique({ where: { id: "main" } });
  const rates = appConfig?.rates as unknown as Record<string, { label: string }>;

  return (
    <div className="screen">
      <TopBar title="My Orders" sub={`${allOrders.length} total`} />

      <div className="pad">
        <OrdersClient orders={allOrders} rates={rates} />
      </div>
    </div>
  );
}

function OrderRow({ order, rates }: { order: any; rates: Record<string, any> }) {
  const items = order.items as unknown as Array<{ label: string; qty: number }>;
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const rateLabel = rates?.[order.service]?.label || order.service;

  return (
    <Link
      href={`/c/orders/${order.id}`}
      className="card mt10"
      style={{ padding: "14px 16px", width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: "13px", textDecoration: "none" }}
    >
      <div
        className="icon-tile"
        style={{
          background:
            order.status === "ready"
              ? "var(--teal-soft)"
              : order.status === "draft"
                ? "var(--line)"
                : "var(--teal-tint)",
        }}
      >
        <Svg name={order.status === "ready" ? "ready" : order.status === "draft" ? "edit" : "bag"} size={22} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="between">
          <span className="h-sm">{rateLabel}</span>
          <span className="mono muted" style={{ fontSize: "12px" }}>
            #{order.id.slice(-4)}
          </span>
        </div>
        <div className="row gap8 mt4" style={{ flexWrap: "wrap" }}>
          <span className={`pill st-${order.status}`}>
            {STATUS_LABEL[order.status] || order.status}
          </span>
          <span className="muted" style={{ fontSize: "12.5px" }}>
            {totalQty} pcs · {fmt(order.total)}
          </span>
          <span className="muted" style={{ fontSize: "12.5px" }}>
            {dateStr(order.createdAt)}
          </span>
          {order.express && (
            <span className="pill amber">
              <Svg name="bolt" size={11} /> Express
            </span>
          )}
        </div>
      </div>
      <span style={{ color: "var(--faint)" }}>
        <Svg name="chevR" size={18} />
      </span>
    </Link>
  );
}
