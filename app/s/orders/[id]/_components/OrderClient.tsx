"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { fmt, dateStr, timeAgo, initials, STATUS_LABEL } from "@/lib/format";
import { isOverdue } from "@/lib/money";

type Order = {
  id: string;
  studentId: string;
  collegeId: string;
  status: string;
  service: string;
  items: Array<{ label: string; rate: any; qty: number }>;
  actualPieces: number | null;
  declaredPieces: number | null;
  weightKg: any;
  express: boolean;
  surcharge: any;
  subtotal: any;
  gst: any;
  total: any;
  paid: boolean;
  paymentMethod: string | null;
  usedCycle: boolean;
  refunded: boolean;
  refundAmount: any;
  redoOfId: string | null;
  rating: number | null;
  ratingComment: string | null;
  createdAt: Date;
  receivedAt: Date | null;
  timeline: Array<{ status: string; at: Date }>;
  student: { id: string; name: string; phone: string; subscription: any };
  college: { id: string; name: string } | null;
  payments: Array<{ method: string; amount: any }>;
  invoice: any;
};

export default function StaffOrderClient({
  order,
  serviceRates,
}: {
  order: Order;
  serviceRates: { label: string; items: Array<[string, number]> };
}) {
  const router = useRouter();
  const [showPaymentSheet, setShowPaymentSheet] = useState(false);
  const [showRefundSheet, setShowRefundSheet] = useState(false);

  const qty = order.actualPieces !== null ? order.actualPieces : order.declaredPieces;
  const late = isOverdue(order) && (order.status === "received" || order.status === "processing");
  const isDraft = order.status === "draft";
  const redoOf = order.redoOfId;

  return (
    <div className="pad">
      {/* Student card */}
      <button
        onClick={() => router.push(`/s/customers/${order.studentId}`)}
        className="card"
        style={{
          width: "100%",
          textAlign: "left",
          padding: "13px 15px",
          display: "flex",
          alignItems: "center",
          gap: "12px",
        }}
      >
        <div className="avatar">{initials(order.student.name)}</div>
        <div style={{ flex: 1 }}>
          <div className="h-sm">{order.student.name}</div>
          <div className="muted" style={{ fontSize: "12px" }}>
            ID {order.studentId} · {order.student.subscription?.cyclesUsed || 0} pcs lifetime
          </div>
        </div>
        <span className={`pill st-${order.status}`}>{STATUS_LABEL[order.status] || order.status}</span>
      </button>

      <div className="mono muted center mt8" style={{ fontSize: "12px" }}>
        Order #{order.id} · {order.college?.name || ""}
      </div>

      {/* Alerts */}
      {late && (
        <div className="card pad mt12" style={{ background: "var(--red-soft)", borderColor: "#f0c9c4" }}>
          <div className="row gap8">
            <span style={{ color: "var(--red)" }}>
              <Svg name="alert" size={18} />
            </span>
            <span style={{ color: "var(--red)", fontSize: "12.5px", fontWeight: "600" }}>
              Overdue — prioritise this order.
            </span>
          </div>
        </div>
      )}

      {order.refunded && (
        <span className="pill mt12" style={{ background: "var(--red-soft)", color: "var(--red)" }}>
          <Svg name="back" size={13} /> Refunded {fmt(Number(order.refundAmount || 0))}
        </span>
      )}

      {redoOf && (
        <span className="pill mt12">
          <Svg name="layers" size={13} /> Free re-do of #{redoOf.slice(-4)}
        </span>
      )}

      {order.rating && (
        <div className="card pad mt12">
          <div className="between">
            <span className="label">Customer rating</span>
            <span style={{ color: "#e8a92b", fontSize: "16px", letterSpacing: "2px" }}>
              {"★".repeat(order.rating)}
              {"☆".repeat(5 - order.rating)}
            </span>
          </div>
          {order.ratingComment && (
            <div className="muted mt4" style={{ fontSize: "12.5px" }}>
              "{order.ratingComment}"
            </div>
          )}
        </div>
      )}

      {/* Bill card */}
      <div className="card pad mt16">
        {order.items
          .filter((i) => i.qty > 0)
          .map((it) => (
            <div key={it.label} className="kv">
              <span className="k">
                {it.label} ×{it.qty}
              </span>
              <span className="mono">{fmt(it.rate * it.qty)}</span>
            </div>
          ))}
        <div className="kv">
          <span className="k">Subtotal</span>
          <span className="mono">{fmt(Number(order.subtotal))}</span>
        </div>
        {order.surcharge ? (
          <div className="kv">
            <span className="k">Express (same-day)</span>
            <span className="mono">{fmt(Number(order.surcharge))}</span>
          </div>
        ) : null}
        <div className="kv">
          <span className="k">GST (18%)</span>
          <span className="mono">{fmt(Number(order.gst))}</span>
        </div>
        <div className="kv total">
          <span>Total</span>
          <span className="mono">{fmt(Number(order.total))}</span>
        </div>
      </div>

      {/* Payment status */}
      {!order.paid && !order.usedCycle && (
        <button
          className="btn ghost mt10"
          onClick={() => setShowPaymentSheet(true)}
        >
          <Svg name="card" size={17} /> Record payment
        </button>
      )}
      {order.paid && (
        <div className="pill mt12">
          <Svg name="check" size={13} /> Paid · {order.paymentMethod?.toUpperCase()}
        </div>
      )}
      {order.usedCycle && (
        <div className="pill mt12">
          <Svg name="layers" size={13} /> Subscription cycle used
        </div>
      )}

      {/* Action buttons */}
      <div className="divider" />
      <div className="row gap8" style={{ flexWrap: "wrap" }}>
        <button className="btn xs sec" onClick={() => {/* print tag */}}>
          <Svg name="printer" size={15} /> Print tag
        </button>
        <button className="btn xs sec" onClick={() => {/* compensation */}}>
          <Svg name="gift" size={15} /> Compensation
        </button>
        {order.invoice && (
          <button className="btn xs sec" onClick={() => {/* view invoice */}}>
            <Svg name="card" size={15} /> GST bill
          </button>
        )}
        <button className="btn xs sec" style={{ color: "#0f8a4d", borderColor: "#bfe6cf" }}>
          <Svg name="chat" size={15} /> WhatsApp
        </button>
        {order.paid && !order.refunded && (
          <button className="btn xs sec danger" onClick={() => setShowRefundSheet(true)}>
            <Svg name="back" size={15} /> Refund
          </button>
        )}
      </div>
    </div>
  );
}
