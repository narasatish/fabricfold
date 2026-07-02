"use client";
import { useState, useMemo } from "react";
import { Svg } from "@/components/icons";
import { fmt, timeAgo } from "@/lib/format";
import { Seg } from "@/components/chrome";
import type { Decimal } from "@prisma/client/runtime/library";

type ReportData = {
  payments: Array<{ method: string; amount: Decimal; createdAt: Date; orderId?: string }>;
  invoices: Array<{ subtotal: Decimal; gst: Decimal; createdAt: Date }>;
  creditNotes: Array<{ gst: Decimal; createdAt: Date }>;
  expenses: Array<{ amount: Decimal; category: string; note: string; method: string; createdAt: Date }>;
  orders: Array<{ createdAt: Date; receivedAt?: Date; collectedAt?: Date; status: string }>;
  complaints: Array<{ createdAt: Date; status: string }>;
  appConfig: any;
};

export default function StaffReportsClient(props: ReportData) {
  const [period, setPeriod] = useState<"day" | "month" | "year" | "all">("day");
  const [selectedDate, setSelectedDate] = useState(new Date());

  const filteredPayments = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    if (period === "day") {
      return props.payments.filter(
        (p) => new Date(p.createdAt).getTime() >= today.getTime()
      );
    }
    if (period === "month") {
      const start = new Date(now.getFullYear(), now.getMonth(), 1);
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      return props.payments.filter((p) => {
        const d = new Date(p.createdAt);
        return d >= start && d <= end;
      });
    }
    if (period === "year") {
      const start = new Date(now.getFullYear(), 0, 1);
      const end = new Date(now.getFullYear(), 11, 31);
      return props.payments.filter((p) => {
        const d = new Date(p.createdAt);
        return d >= start && d <= end;
      });
    }
    return props.payments;
  }, [period, props.payments]);

  const cashReceived = filteredPayments
    .filter((p) => p.method === "cash" && Number(p.amount) > 0)
    .reduce((sum, p) => sum + Number(p.amount), 0);

  const upiReceived = filteredPayments
    .filter((p) => p.method === "upi" && Number(p.amount) > 0)
    .reduce((sum, p) => sum + Number(p.amount), 0);

  const creditReceived = filteredPayments
    .filter((p) => p.method === "credit" && Number(p.amount) > 0)
    .reduce((sum, p) => sum + Number(p.amount), 0);

  const totalReceived = cashReceived + upiReceived + creditReceived;

  return (
    <div className="pad">
      {/* Period picker */}
      <Seg<"day" | "month" | "year" | "all">
        options={[
          ["day", "Day"],
          ["month", "Month"],
          ["year", "Year"],
          ["all", "All"],
        ]}
        value={period}
        onChange={setPeriod}
      />

      {/* Collections hero */}
      <div
        className="card pad mt16"
        style={{
          background: "#10201b",
          color: "#fff",
          border: "none",
          boxShadow: "0 8px 24px rgba(0,0,0,.2)",
        }}
      >
        <div className="muted" style={{ fontSize: "11.5px", letterSpacing: ".05em", marginBottom: "8px" }}>
          TOTAL RECEIVED
        </div>
        <div className="big-num">{fmt(totalReceived)}</div>

        <div className="divider" style={{ borderColor: "rgba(255,255,255,.12)", marginTop: "12px", marginBottom: "12px" }} />

        <div className="kv" style={{ color: "rgba(255,255,255,.7)" }}>
          <span className="k">Cash</span>
          <span className="mono">{fmt(cashReceived)}</span>
        </div>
        <div className="kv" style={{ color: "rgba(255,255,255,.7)" }}>
          <span className="k">UPI</span>
          <span className="mono">{fmt(upiReceived)}</span>
        </div>
        <div className="kv" style={{ color: "rgba(255,255,255,.7)" }}>
          <span className="k">Credits redeemed</span>
          <span className="mono">{fmt(creditReceived)}</span>
        </div>
      </div>

      {/* Export buttons */}
      <div className="row gap8 mt16" style={{ flexWrap: "wrap" }}>
        <button className="btn xs sec">Full report</button>
        <button className="btn xs sec">Transactions</button>
        <button className="btn xs sec">GST invoices</button>
        <button className="btn xs sec">Expenses</button>
      </div>

      {/* Quick stats */}
      <div className="sec-title mt20">Overview</div>
      <div className="card pad mt10">
        <div className="kv">
          <span className="k">Orders completed</span>
          <span className="mono">{props.orders.filter((o) => o.status === "collected").length}</span>
        </div>
        <div className="kv">
          <span className="k">Avg turnaround</span>
          <span className="mono">~18h</span>
        </div>
      </div>

      {/* Tax & GST */}
      <div className="sec-title mt20">Tax & GST</div>
      <div className="card pad mt10">
        <div className="kv">
          <span className="k">Taxable invoices (UPI only)</span>
          <span className="mono">{props.invoices.length}</span>
        </div>
        <div className="kv">
          <span className="k">GST collected</span>
          <span className="mono">
            {fmt(props.invoices.reduce((s, i) => s + Number(i.gst), 0))}
          </span>
        </div>
        <div className="kv">
          <span className="k">Credit note GST</span>
          <span className="mono">
            −{fmt(props.creditNotes.reduce((s, c) => s + Number(c.gst), 0))}
          </span>
        </div>
      </div>

      {/* Expenses */}
      {props.expenses.length > 0 && (
        <>
          <div className="sec-title mt20">Expenses</div>
          <div className="card pad mt10">
            {props.expenses.slice(0, 5).map((e) => (
              <div key={e.category} className="kv">
                <span className="k">{e.category}</span>
                <span className="mono">{fmt(Number(e.amount))}</span>
              </div>
            ))}
            <div className="kv" style={{ marginTop: "8px", borderTop: "1px dashed var(--line-2)", paddingTop: "8px" }}>
              <span className="k" style={{ fontWeight: "600" }}>
                Total expenses
              </span>
              <span className="mono" style={{ fontWeight: "600" }}>
                {fmt(props.expenses.reduce((s, e) => s + Number(e.amount), 0))}
              </span>
            </div>
          </div>
        </>
      )}

      {/* Transactions list */}
      <div className="sec-title mt20">Recent transactions</div>
      {filteredPayments.slice(0, 10).map((p) => (
        <div key={p.createdAt.toString()} className="card pad mt10">
          <div className="kv">
            <span className="k">{p.method}</span>
            <span className="mono">{fmt(Number(p.amount))}</span>
          </div>
          <div className="muted" style={{ fontSize: "12px", marginTop: "4px" }}>
            {timeAgo(p.createdAt)}
          </div>
        </div>
      ))}
    </div>
  );
}
