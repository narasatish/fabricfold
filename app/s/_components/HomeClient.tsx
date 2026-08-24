"use client";
import { useState, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { Seg, Sheet, useToast } from "@/components/chrome";
import { fmt, timeAgo, initials } from "@/lib/format";
import { isOverdue } from "@/lib/money";
import { dayLabel, hhmm, istDateStr, istMinutes } from "@/lib/slots";
import { activateSubscription } from "@/lib/actions/subscription";
import { registerStudent } from "@/lib/actions/admin";
import { searchStudents } from "@/lib/actions/students";
import { clockIn, clockOut } from "@/lib/actions/ops";

type Order = {
  id: string;
  studentId: string;
  status: string;
  express: boolean;
  actualPieces: number | null;
  declaredPieces: number | null;
  weightKg: number | null;
  total: number;
  paid: boolean;
  createdAt: number;
  receivedAt: number | null;
  dropSlotAt: number | null;
  student: { id: string; name: string; phone: string };
};

type PendingSub = {
  studentId: string;
  student: { id: string; name: string };
  hasOtp: boolean;
};

type Metrics = { todayRevenue: number; pending: number; ready: number; activeSubs: number; newStudents: number };

export default function StaffHomeClient({
  staff,
  orders,
  pendingSubs,
  colleges,
  metrics,
  attendance,
}: {
  staff: { name: string; role: number };
  orders: Order[];
  pendingSubs: PendingSub[];
  colleges: { id: string; name: string }[];
  metrics: Metrics;
  attendance: { clockedIn: boolean; clockedOut: boolean; since: number | null };
}) {
  const router = useRouter();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "received" | "processing" | "ready" | "overdue">("all");
  const [showSubSheet, setShowSubSheet] = useState<string | null>(null);
  const [subMethod, setSubMethod] = useState<"cash" | "upi">("upi");
  const [subOtp, setSubOtp] = useState("");
  const [showRegister, setShowRegister] = useState(false);
  const [reg, setReg] = useState({ name: "", phone: "", collegeId: colleges[0]?.id || "" });
  const [regLoading, setRegLoading] = useState(false);

  const q = search.trim().toLowerCase();

  // Actionable orders: draft, received, processing, ready (sorted by status then date desc)
  const actionable = orders.filter((o) => ["draft", "received", "processing", "ready"].includes(o.status));
  const ov = (o: Order) => isOverdue({ status: o.status, receivedAt: o.receivedAt ? new Date(o.receivedAt) : null, express: o.express });
  const overdueOrders = actionable.filter(ov);

  // Filter by filter type
  const filtered =
    filter === "all"
      ? actionable
      : filter === "overdue"
        ? overdueOrders
        : filter === "received"
          ? actionable.filter((o) => o.status === "received" || o.status === "draft")
          : actionable.filter((o) => o.status === filter);

  /* Students come from the server; orders are already on this page, so they
     stay client-side. Debounced so a four-letter name is one query, not four,
     and guarded by a sequence number so a slow early response cannot land on
     top of a later one and show results for a query already replaced. */
  const [foundStudents, setFoundStudents] = useState<{ id: string; name: string; phone: string }[]>([]);
  const searchSeq = useRef(0);
  useEffect(() => {
    if (!q) { setFoundStudents([]); return; }
    const seq = ++searchSeq.current;
    const t = setTimeout(async () => {
      const r = await searchStudents(q);
      if (seq === searchSeq.current && r.ok) setFoundStudents(r.students);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const searchResults = useMemo(() => {
    if (!q) return null;
    return { students: foundStudents, orders: orders.filter((o) => o.id.toLowerCase().includes(q)) };
  }, [q, orders, foundStudents]);

  const handleClock = async () => {
    const r = attendance.clockedIn && !attendance.clockedOut ? await clockOut() : await clockIn();
    if (!r.ok) return toast(r.error || "Failed", true);
    toast("hours" in r && r.hours ? `Clocked out — ${r.hours}h today` : "Clocked in — have a good shift!");
    router.refresh();
  };

  const handleRegister = async () => {
    setRegLoading(true);
    const r = await registerStudent(reg);
    setRegLoading(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast(`Student registered — ID ${r.id}`);
    setShowRegister(false);
    setReg({ name: "", phone: "", collegeId: colleges[0]?.id || "" });
    router.push(`/s/customers/${r.id}`);
  };

  const handleActivateSub = async (studentId: string) => {
    const r = await activateSubscription(studentId, subMethod, subOtp || undefined);
    if (!r.ok) {
      toast(r.error || "Failed", true);
      return;
    }
    toast("Subscription activated");
    setShowSubSheet(null);
    setSubOtp("");
    router.refresh();
  };

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
    const late = ov(o) && (o.status === "received" || o.status === "processing");

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
              {o.status === "draft" && o.dropSlotAt && (
                <span className="pill gray" title="Booked drop-off window">
                  <Svg name="clock" size={11} /> {dayLabel(istDateStr(o.dropSlotAt), Date.now())} {hhmm(istMinutes(o.dropSlotAt))}
                </span>
              )}
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
      {/* Attendance */}
      <div className="chip-toggle" style={{ marginBottom: 12 }}>
        <div>
          <div className="h-sm">
            {attendance.clockedOut ? "Shift complete for today" : attendance.clockedIn ? `On shift since ${attendance.since ? new Date(attendance.since).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : ""}` : "Not clocked in"}
          </div>
          <div className="muted" style={{ fontSize: "12px" }}>Attendance is recorded for payroll</div>
        </div>
        {!attendance.clockedOut && (
          <button className={`btn sm ${attendance.clockedIn ? "sec" : ""}`} onClick={handleClock}>
            {attendance.clockedIn ? "Clock out" : "Clock in"}
          </button>
        )}
      </div>

      {/* At-a-glance dashboard */}
      <div className="stat-grid">
        <div className="stat-tile">
          <div className="stat-num">{fmt(metrics.todayRevenue)}</div>
          <div className="stat-lbl">Today&apos;s takings</div>
        </div>
        <button className="stat-tile tap" onClick={() => setFilter("received")}>
          <div className="stat-num">{metrics.pending}</div>
          <div className="stat-lbl">In progress</div>
        </button>
        <button className="stat-tile tap" onClick={() => setFilter("ready")}>
          <div className="stat-num">{metrics.ready}</div>
          <div className="stat-lbl">Ready to collect</div>
        </button>
        <div className="stat-tile">
          <div className="stat-num">{metrics.activeSubs}</div>
          <div className="stat-lbl">Active plans</div>
        </div>
      </div>
      {metrics.newStudents > 0 && (
        <div className="muted center mt8" style={{ fontSize: "12px" }}>
          {metrics.newStudents} new student{metrics.newStudents > 1 ? "s" : ""} registered today
        </div>
      )}

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

      {/* Student management */}
      <div className="row gap8 mt10">
        <button className="btn ghost" onClick={() => setShowRegister(true)}>
          <Svg name="edit" size={17} /> Register student
        </button>
        <button className="btn sec" onClick={() => router.push("/s/students")}>
          <Svg name="building" size={17} /> All students
        </button>
      </div>

      {/* Search results or main view */}
      {q ? (
        <div style={{ marginTop: "16px" }}>
          {searchResults?.students.length ? (
            <>
              <div className="sec-title">Students</div>
              {searchResults.students.slice(0, 10).map((st) => (
                <button key={st.id} className="card-btn mt10" onClick={() => router.push(`/s/customers/${st.id}`)}>
                  <div className="avatar">{initials(st.name)}</div>
                  <div className="grow">
                    <div className="h-sm">{st.name}</div>
                    <div className="muted" style={{ fontSize: "12.5px" }}>ID {st.id} · {st.phone}</div>
                  </div>
                  <Svg name="chevR" size={18} />
                </button>
              ))}
            </>
          ) : null}
          {searchResults?.orders.length ? (
            <>
              <div className="sec-title mt12">{searchResults.orders.length} order(s)</div>
              {searchResults.orders.slice(0, 20).map(renderOrderRow)}
            </>
          ) : !searchResults?.students.length ? (
            <div className="empty" style={{ padding: "34px" }}>
              <Svg name="search" size={44} />
              <div>Nothing found</div>
              <button className="btn sm mt16" onClick={() => setShowRegister(true)}>Register this student</button>
            </div>
          ) : null}
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
                  onClick={() => setShowSubSheet(p.studentId)}
                >
                  <div className="icon-tile" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
                    <Svg name="card" size={22} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div className="h-sm">{p.student.name}</div>
                    <div className="muted" style={{ fontSize: "12.5px" }}>
                      {p.hasOtp ? "Cash — verify the student’s OTP" : "Awaiting approval"}
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

      {/* Register-student sheet */}
      <Sheet open={showRegister} onClose={() => setShowRegister(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>Register new student</h2>
          <p className="muted" style={{ fontSize: "13px", marginBottom: "16px" }}>
            They&apos;ll log in with this number and see their campus rates right away.
          </p>
          <div className="field">
            <label>Full name</label>
            <input className="input" type="text" placeholder="Student's name" value={reg.name}
              onChange={(e) => setReg({ ...reg, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Mobile number</label>
            <input className="input" type="tel" inputMode="numeric" placeholder="10-digit number" value={reg.phone}
              onChange={(e) => setReg({ ...reg, phone: e.target.value.replace(/\D/g, "").slice(0, 10) })} />
          </div>
          <div className="field">
            <label>Campus</label>
            <select className="input" value={reg.collegeId} onChange={(e) => setReg({ ...reg, collegeId: e.target.value })}>
              {colleges.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <button className="btn mt16" onClick={handleRegister} disabled={regLoading || !reg.name.trim() || reg.phone.length !== 10}>
            <Svg name="check" size={18} /> {regLoading ? "Registering…" : "Register student"}
          </button>
        </div>
      </Sheet>

      {/* Subscription activation sheet */}
      <Sheet open={showSubSheet !== null} onClose={() => setShowSubSheet(null)}>
        <div className="pad">
          <h2 style={{ marginBottom: "16px" }}>Activate subscription</h2>
          <Seg<"cash" | "upi">
            options={[
              ["cash", "Cash"],
              ["upi", "UPI"],
            ]}
            value={subMethod}
            onChange={setSubMethod}
          />
          {subMethod === "cash" && (
            <div className="field mt16">
              <label>OTP (student shows on their phone)</label>
              <input
                className="input"
                type="text"
                placeholder="4 digits"
                value={subOtp}
                onChange={(e) => setSubOtp(e.target.value)}
                maxLength={4}
              />
            </div>
          )}
          <button
            className="btn mt16"
            onClick={() => {
              if (showSubSheet) handleActivateSub(showSubSheet);
            }}
          >
            <Svg name="check" size={18} /> Activate
          </button>
        </div>
      </Sheet>
    </div>
  );
}
