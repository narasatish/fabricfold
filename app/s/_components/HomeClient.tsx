"use client";
import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { Seg } from "@/components/chrome";
import { fmt, timeAgo, initials } from "@/lib/format";
import { isOverdue } from "@/lib/money";

type Order = {
  id: string;
  studentId: string;
  status: string;
  express: boolean;
  actualPieces: number | null;
  declaredPieces: number | null;
  weightKg: any;
  total: any;
  paid: boolean;
  createdAt: Date;
  receivedAt: Date | null;
  student: { id: string; name: string; phone: string };
};

type Otp = {
  studentId: string;
  student: { id: string; name: string };
  refId?: string;
  payload?: Record<string, unknown>;
};

export default function StaffHomeClient({
  staff,
  orders,
  pendingSubs,
}: {
  staff: { name: string; role: number };
  orders: Order[];
  pendingSubs: Otp[];
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "received" | "processing" | "ready" | "overdue">("all");

  const q = search.trim().toLowerCase();

  // Actionable orders: draft, received, processing, ready (sorted by status then date desc)
  const actionable = orders.filter((o) => ["draft", "received", "processing", "ready"].includes(o.status));
  const overdueOrders = actionable.filter((o) => isOverdue(o));

  // Filter by filter type
  const filtered =
    filter === "all"
      ? actionable
      : filter === "overdue"
        ? overdueOrders
        : actionable.filter((o) => o.status === filter);

  // Search results (students and orders by ID/phone/name)
  const searchResults = useMemo(() => {
    if (!q) return null;
    return {
      students: [], // TODO: fetch students from DB on client side or use search params
      orders: orders.filter((o) => o.id.toLowerCase().includes(q)),
    };
  }, [q, orders]);

  const renderOrderRow = (o: Order) => {
    const pieces = o.actualPieces !== null ? o.actualPieces : o.declaredPieces;
    const statusLabel = {
      draft: "Draft",
      received: "Received",
      processing: "Processing",
      ready: "Ready",
      collected: "Collected",
      cancelled: "Cancelled",
    }[o.status] || o.status;

    const statusClass = `st-${o.status}`;
    const late = isOverdue(o) && (o.status === "received" || o.status === "processing");

    return (
      <button
        key={o.id}
        onClick={() => router.push(`/s/orders/${o.id}`)}
        className="card-btn mt10"
      >
        <div className="grow">
          <div className="between">
            <div className="h-sm"># {o.id.slice(-4)}</div>
            <div className="row gap8">
              {late && <span className="pill red">Late</span>}
              {o.express && <span className="pill amber">EXPRESS</span>}
            </div>
          </div>
          <div className="muted mt4" style={{ fontSize: "13px" }}>
            {o.student.name}
          </div>
          <div className="between mt4" style={{ fontSize: "13.5px" }}>
            <div className="muted">
              {pieces} pieces · {Number(o.weightKg || 0)} kg
            </div>
            <div>{timeAgo(o.createdAt)}</div>
          </div>
        </div>
        <div className={`pill ${statusClass}`} style={{ marginLeft: "8px" }}>
          {statusLabel}
        </div>
      </button>
    );
  };

  return (
    <div className="pad">
      {/* Search box */}
      <div className="card" style={{ padding: "4px 6px", display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ color: "var(--muted)", paddingLeft: "8px" }}>
          <Svg name="search" size={20} />
        </span>
        <input
          className="input"
          placeholder="Search ID / phone / name / order #"
          style={{ border: "none", boxShadow: "none", height: "44px" }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button className="action" onClick={() => setSearch("")} aria-label="Clear search">
            <Svg name="x" size={18} />
          </button>
        )}
      </div>

      {/* Search results or main view */}
      {q ? (
        <div style={{ marginTop: "16px" }}>
          {searchResults?.orders.length ? (
            <>
              <div className="sec-title">{searchResults.orders.length} order(s)</div>
              {searchResults.orders.slice(0, 20).map(renderOrderRow)}
            </>
          ) : (
            <div className="empty" style={{ padding: "34px" }}>
              <Svg name="search" size={44} />
              <div>Nothing found</div>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Subscription requests */}
          {pendingSubs.length > 0 && (
            <>
              <div className="sec-title mt20">Subscription requests</div>
              {pendingSubs.map((p) => (
                <button
                  key={p.studentId}
                  className="card mt10"
                  style={{ width: "100%", textAlign: "left", padding: "14px 16px", display: "flex", alignItems: "center", gap: "13px" }}
                  onClick={() => router.push(`/s/customers/${p.studentId}`)}
                >
                  <div className="icon-tile" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
                    <Svg name="card" size={22} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="h-sm">{p.student.name}</div>
                    <div className="muted" style={{ fontSize: "12.5px" }}>
                      {(p.payload as any)?.method === "cash" ? "Cash — needs OTP verification" : "UPI — needs approval"}
                    </div>
                  </div>
                  <span className="pill amber">Review</span>
                </button>
              ))}
            </>
          )}

          {/* Overdue banner */}
          {overdueOrders.length > 0 && (
            <button
              className="card pad mt20"
              onClick={() => setFilter("overdue")}
              style={{
                width: "100%",
                textAlign: "left",
                background: "var(--red-soft)",
                borderColor: "#f0c9c4",
              }}
            >
              <div className="row gap8">
                <span style={{ color: "var(--red)" }}>
                  <Svg name="alert" size={20} />
                </span>
                <span style={{ color: "var(--red)", fontSize: "13.5px", fontWeight: "600" }}>
                  {overdueOrders.length} order{overdueOrders.length > 1 ? "s" : ""} overdue — past turnaround
                </span>
              </div>
            </button>
          )}

          {/* Filter chips */}
          <div className="between mt20" style={{ padding: "0 4px" }}>
            <span className="sec-title" style={{ padding: "0" }}>
              Needs action
            </span>
            <span className="pill gray">{actionable.length}</span>
          </div>

          <Seg<"all" | "received" | "processing" | "ready" | "overdue">
            options={[
              ["all", "All"],
              ["received", "New"],
              ["processing", "Wash"],
              ["ready", "Ready"],
              ["overdue", `Late${overdueOrders.length ? ` ${overdueOrders.length}` : ""}`],
            ]}
            value={filter}
            onChange={setFilter}
          />

          <div className="mt10">
            {filtered.length ? (
              filtered.map(renderOrderRow)
            ) : (
              <div className="card pad center muted" style={{ padding: "24px" }}>
                {filter === "all" ? "All caught up" : "Nothing here"}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
