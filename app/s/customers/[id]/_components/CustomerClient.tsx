"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { fmt, dateStr, timeAgo, initials } from "@/lib/format";

type Student = {
  id: string;
  name: string;
  phone: string;
  credits: any;
  lifetimePieces: number;
  createdAt: Date;
  college: { id: string; name: string } | null;
  subscription: any;
  orders: any[];
  compensations: any[];
  creditUses: any[];
};

export default function StaffCustomerClient({ student }: { student: Student }) {
  const router = useRouter();

  return (
    <div className="pad">
      {/* Profile card */}
      <div className="card pad">
        <div className="row gap12" style={{ marginBottom: "16px" }}>
          <div className="avatar" style={{ width: "56px", height: "56px", fontSize: "20px" }}>
            {initials(student.name)}
          </div>
          <div style={{ flex: 1 }}>
            <div className="h-md">{student.name}</div>
            <div className="muted">ID {student.id}</div>
            <div className="muted" style={{ fontSize: "12px" }}>
              +91 {student.phone}
            </div>
          </div>
        </div>

        <div className="divider" />

        <div className="kv">
          <span className="k">College</span>
          <span>{student.college?.name || "—"}</span>
        </div>
        <div className="kv">
          <span className="k">Lifetime pieces</span>
          <span className="mono">{student.lifetimePieces}</span>
        </div>
        <div className="kv">
          <span className="k">Store credit</span>
          <span className="mono">{fmt(Number(student.credits))}</span>
        </div>
        <div className="kv">
          <span className="k">Member since</span>
          <span>{dateStr(student.createdAt)}</span>
        </div>
      </div>

      {/* Subscription */}
      {student.subscription && (
        <div className="card pad mt16">
          <div className="h-sm">Active subscription</div>
          <div className="kv mt8">
            <span className="k">Plan</span>
            <span>{fmt(6800)}</span>
          </div>
          <div className="kv">
            <span className="k">Cycles used</span>
            <span className="mono">{student.subscription.cyclesUsed} / {student.subscription.cyclesTotal}</span>
          </div>
          <div className="kv">
            <span className="k">Expires</span>
            <span>{dateStr(student.subscription.expiresAt)}</span>
          </div>
        </div>
      )}

      {/* Orders */}
      {student.orders.length > 0 && (
        <>
          <div className="sec-title mt20">Order history</div>
          {student.orders.slice(0, 10).map((o) => (
            <button
              key={o.id}
              className="card-btn mt10"
              onClick={() => router.push(`/s/orders/${o.id}`)}
            >
              <div className="grow">
                <div className="h-sm"># {o.id.slice(-4)}</div>
                <div className="muted mt4" style={{ fontSize: "13px" }}>
                  {dateStr(o.createdAt)}
                </div>
              </div>
              <span className={`pill st-${o.status}`}>{o.status}</span>
            </button>
          ))}
        </>
      )}

      {/* Compensations */}
      {student.compensations.length > 0 && (
        <>
          <div className="sec-title mt20">Compensation history</div>
          {student.compensations.map((c) => (
            <div key={c.id} className="card pad mt10">
              <div className="kv">
                <span className="k">{c.kind}</span>
                <span className="mono">{fmt(Number(c.amount))}</span>
              </div>
              <div className="muted" style={{ fontSize: "12px", marginTop: "4px" }}>
                {c.comment}
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
