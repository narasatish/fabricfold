import { requireStudent } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import { fmt, timeAgo, dateStr, STATUS_LABEL } from "@/lib/format";
import { orderDueAt } from "@/lib/money";
import { dayLabel, hhmm, istDateStr, istMinutes } from "@/lib/slots";
import Link from "next/link";
import { Svg } from "@/components/icons";
import { notFound } from "next/navigation";
import OrderDetailClient from "./_components/OrderDetailClient";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const student = await requireStudent();
  const { id } = await params;

  const order = await db.order.findUnique({
    where: { id },
    include: { timeline: true, invoice: true },
  });

  if (!order || order.studentId !== student.id) {
    notFound();
  }

  const appConfig = await db.appConfig.findUnique({ where: { id: "main" } });
  const rates = appConfig?.rates as unknown as Record<string, { label: string }>;
  const rateLabel = rates?.[order.service]?.label || order.service;

  const items = order.items as unknown as Array<{ label: string; rate: number; qty: number }>;
  const totalQty = items.reduce((s, i) => s + i.qty, 0);

  // Customer-facing ETA while the order is in progress.
  const dueAt = orderDueAt({ receivedAt: order.receivedAt, express: order.express });
  const etaLabel =
    dueAt && ["received", "processing"].includes(order.status)
      ? dueAt.toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      : null;

  // Timeline: placed, received, processing, ready, collected
  const timelineLabels: Record<string, string> = {
    placed: "Order placed",
    received: "Received at counter",
    processing: "Processing",
    ready: "Ready for collection",
    collected: "Collected",
  };

  const timelineOrder = ["placed", "received", "processing", "ready", "collected"];

  return (
    <div className="screen">
      <TopBar title={`Order ${order.id.slice(-4)}`} sub={rateLabel} back="/c/orders" />

      <div className="pad">
        <div className="between">
          <span className={`pill st-${order.status}`} style={{ fontSize: "13px", padding: "7px 14px" }}>
            {STATUS_LABEL[order.status] || order.status}
          </span>
          <span className="mono muted" style={{ fontSize: "13px" }}>
            #{order.id}
          </span>
        </div>

        {/* Booked drop-off window */}
        {order.dropSlotAt && order.status === "draft" && (
          <div className="card pad mt16" style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ color: "var(--teal-dark)" }}><Svg name="clock" size={20} /></span>
            <div>
              <div className="muted" style={{ fontSize: "11.5px", textTransform: "uppercase", letterSpacing: ".04em" }}>Drop-off slot</div>
              <div className="h-sm">
                {dayLabel(istDateStr(order.dropSlotAt))} · {hhmm(istMinutes(order.dropSlotAt))}
                {order.dropSlotEndAt ? `–${hhmm(istMinutes(order.dropSlotEndAt))}` : ""}
              </div>
            </div>
          </div>
        )}

        {/* Draft warning */}
        {order.status === "draft" && (
          <div className="card pad mt16" style={{ background: "var(--amber-soft)", borderColor: "#f2e2c4" }}>
            <div className="row gap8">
              <span style={{ color: "var(--amber)" }}>
                <Svg name="alert" size={20} />
              </span>
              <div>
                <div className="h-sm" style={{ color: "var(--amber)" }}>
                  Not dropped off yet
                </div>
                <div style={{ color: "var(--amber)", fontSize: "12.5px", marginTop: "2px" }}>
                  Show Order ID <b>#{order.id.slice(-4)}</b> + FabricFold ID <b>{student.id}</b> at the counter.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Ready for collection */}
        {order.status === "ready" && (
          <div className="card pad mt16" style={{ background: "var(--teal-soft)", borderColor: "#c8e6da" }}>
            <div className="row gap8">
              <span style={{ color: "var(--teal-dark)" }}>
                <Svg name="ready" size={22} />
              </span>
              <div style={{ flex: 1 }}>
                <div className="h-sm" style={{ color: "var(--teal-dark)" }}>
                  Ready for collection
                </div>
                <div style={{ color: "var(--teal-dark)", fontSize: "12.5px", marginTop: "2px" }}>
                  Show your Order ID or FabricFold ID to collect.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Express badge */}
        {order.express && (
          <div className="pill amber mt16">
            <Svg name="bolt" size={12} /> Express same-day
          </div>
        )}

        {/* Estimated ready */}
        {etaLabel && (
          <div className="card pad mt16" style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ color: "var(--teal-dark)" }}><Svg name="clock" size={20} /></span>
            <div>
              <div className="muted" style={{ fontSize: "11.5px", textTransform: "uppercase", letterSpacing: ".04em" }}>Estimated ready by</div>
              <div className="h-sm">{etaLabel}</div>
            </div>
          </div>
        )}

        {/* Status timeline */}
        <div className="sec-title mt20">Status timeline</div>
        <div className="card pad tl">
          {timelineOrder.map((status) => {
            const event = order.timeline.find((t: any) => t.status === status);
            const done = !!event;
            return (
              <div key={status} className={`tl-item ${done ? "done" : ""}`}>
                <div className="tl-dot">
                  {done && (
                    <Svg name="check" size={12} />
                  )}
                </div>
                <div style={{ flex: 1 }}>
                  <div className="h-sm" style={{ color: done ? "inherit" : "var(--faint)" }}>
                    {timelineLabels[status]}
                  </div>
                  {event && (
                    <div className="muted" style={{ fontSize: "12px" }}>
                      {dateStr(event.at)} · {timeAgo(event.at)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Itemised charges */}
        <div className="sec-title mt20">Itemised charges</div>
        <div className="card pad">
          {items.map((it) => (
            <div key={it.label} className="kv">
              <span className="k">
                {it.label} <span className="muted">×{it.qty}</span>
              </span>
              <span className="mono">{fmt(Number(it.rate) * it.qty)}</span>
            </div>
          ))}
          <div className="kv">
            <span className="k">Subtotal ({totalQty} pcs)</span>
            <span className="mono">{fmt(Number(order.subtotal ?? 0))}</span>
          </div>
          {(Number(order.surcharge ?? 0)) > 0 && (
            <div className="kv">
              <span className="k">Express surcharge</span>
              <span className="mono">{fmt(Number(order.surcharge ?? 0))}</span>
            </div>
          )}
          <div className="kv">
            <span className="k">{order.noGst || Number(order.gstPctSnapshot) === 0 ? "GST — not charged" : `GST (${Number(order.gstPctSnapshot)}%)`}</span>
            <span className="mono">{fmt(Number(order.gst))}</span>
          </div>
          <div className="kv total">
            <span>Total</span>
            <span className="mono">{fmt(Number(order.total))}</span>
          </div>
        </div>

        {/* Pay button or paid badge */}
        {!order.paid && !order.usedCycle && !["draft", "cancelled"].includes(order.status) && (
          <Link href={`/c/pay/${order.id}`} className="btn mt16">
            <Svg name="card" size={18} /> Pay {fmt(Number(order.total))}
          </Link>
        )}

        {order.paid && (
          <div className="pill mt16">
            <Svg name="check" size={13} /> Paid via {order.paymentMethod?.toUpperCase()}
          </div>
        )}

        {/* Invoice link */}
        {order.paid && order.invoice && (
          <a href={`/api/export/invoice/${order.id}`} className="btn ghost mt12">
            <Svg name="card" size={17} /> View / download GST bill
          </a>
        )}

        {/* Rating (if collected) */}
        {order.status === "collected" && (
          <OrderDetailClient orderId={order.id} initialRating={order.rating ?? undefined} />
        )}

        {/* Reorder button */}
        {!["draft", "cancelled"].includes(order.status) && (
          <Link href={`/c/order/new?reorder=${order.id}`} className="btn sec mt12">
            <Svg name="bag" size={17} /> Reorder these items
          </Link>
        )}

        {/* Delete draft */}
        {order.status === "draft" && (
          <OrderDetailClient orderId={order.id} isDraft />
        )}

        {/* Report issue */}
        <Link href={`/c/help?orderId=${order.id}`} className="btn ghost mt12">
          <Svg name="chat" size={17} /> Report an issue
        </Link>
      </div>
    </div>
  );
}
