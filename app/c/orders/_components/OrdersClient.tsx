"use client";
import { useState } from "react";
import { Seg } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { fmt, dateStr, STATUS_LABEL } from "@/lib/format";
import Link from "next/link";

type Order = {
  id: string;
  service: string;
  status: string;
  total: number;
  express: boolean;
  items: unknown;
  createdAt: Date;
};

export default function OrdersClient({ orders, rates }: { orders: Order[]; rates: Record<string, any> }) {
  const [filter, setFilter] = useState<"all" | "active" | "draft" | "collected">("all");

  const filtered =
    filter === "all"
      ? orders
      : filter === "active"
        ? orders.filter((o) => ["received", "processing", "ready"].includes(o.status))
        : filter === "draft"
          ? orders.filter((o) => o.status === "draft")
          : orders.filter((o) => o.status === "collected");

  return (
    <>
      <Seg<string>
        options={[
          ["all", "All"],
          ["active", "Active"],
          ["draft", "Drafts"],
          ["collected", "Done"],
        ]}
        value={filter}
        onChange={(f) => setFilter(f as any)}
      />

      <div className="mt12">
        {filtered.length > 0 ? (
          filtered.map((o) => <OrderRow key={o.id} order={o} rates={rates} />)
        ) : (
          <div className="empty">
            <Svg name="bag" size={48} />
            <div>No orders here yet</div>
          </div>
        )}
      </div>
    </>
  );
}

function OrderRow({ order, rates }: { order: Order; rates: Record<string, any> }) {
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
