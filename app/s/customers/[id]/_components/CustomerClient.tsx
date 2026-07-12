"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { Qr } from "@/components/qr";
import { fmt, dateStr, timeAgo, initials, STATUS_LABEL, loyaltyBadge } from "@/lib/format";
import { Seg, Sheet, useToast } from "@/components/chrome";
import { submitCompensation } from "@/lib/actions/credits";
import { assignSubscription } from "@/lib/actions/subscription";

type Student = {
  id: string;
  name: string;
  phone: string;
  credits: number;
  lifetimePieces: number;
  createdAt: number;
  college: { id: string; name: string } | null;
  subscription: {
    active: boolean; plan: string; cyclesTotal: number; cyclesUsed: number; kgPerCycle: number;
    expiresAt: number | null; cycleLog: { at: number; orderId: string }[];
  } | null;
  orders: { id: string; status: string; service: string; total: number; createdAt: number }[];
  compensations: { id: string; kind: string; amount: number; method: string; comment: string | null; at: number }[];
  creditUses: { id: string; amount: number; orderId: string; at: number }[];
};

const KIND_LABEL: Record<string, string> = { damage: "Damage", stain: "Stain / re-do", missing: "Missing item", goodwill: "Goodwill", manual: "Adjustment" };

export default function StaffCustomerClient({ student, staffRole, plan }: { student: Student; staffRole: number; plan: { price: number; cycles: number; kgPerCycle: number; gross: number } }) {
  const router = useRouter();
  const toast = useToast();
  const tier = loyaltyBadge(student.lifetimePieces);
  const [showComp, setShowComp] = useState(false);
  const [comp, setComp] = useState({ kind: "damage", amount: 0, method: "credit" as "credit" | "cash", comment: "" });
  const [showAssign, setShowAssign] = useState(false);
  const [assignMethod, setAssignMethod] = useState<"cash" | "upi">("upi");
  const [assignLoading, setAssignLoading] = useState(false);

  const doAssign = async () => {
    setAssignLoading(true);
    const r = await assignSubscription(student.id, assignMethod);
    setAssignLoading(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast("Annual plan activated");
    setShowAssign(false);
    router.refresh();
  };

  const doComp = async () => {
    const r = await submitCompensation({ studentId: student.id, orderId: null, kind: comp.kind, amount: comp.amount, method: comp.method, comment: comp.comment });
    if (!r.ok) return toast(r.error || "Failed", true);
    toast("Compensation issued");
    setShowComp(false);
    router.refresh();
  };

  return (
    <div className="pad">
      {/* Profile card */}
      <div className="card pad">
        <div className="row gap12" style={{ marginBottom: "14px" }}>
          <div className="avatar" style={{ width: "56px", height: "56px", fontSize: "20px" }}>{initials(student.name)}</div>
          <div style={{ flex: 1 }}>
            <div className="h-md">{student.name}</div>
            <div className="muted mono">ID {student.id}</div>
            <div className="muted" style={{ fontSize: "12px" }}>+91 {student.phone}</div>
          </div>
          <Qr text={student.id} size={64} />
        </div>
        <div className="row gap8">
          <span className="pill" style={{ background: tier.bg, color: tier.fg }}>{tier.name}</span>
          <span className="pill gray">{student.lifetimePieces} pcs lifetime</span>
        </div>
        <div className="divider" />
        <div className="kv"><span className="k">College</span><span>{student.college?.name || "—"}</span></div>
        <div className="kv"><span className="k">Store credit</span><span className="mono">{fmt(student.credits)}</span></div>
        <div className="kv"><span className="k">Member since</span><span>{dateStr(student.createdAt)}</span></div>
      </div>

      <button className="btn ghost mt12" onClick={() => setShowComp(true)}>
        <Svg name="gift" size={17} /> Issue compensation
      </button>

      {staffRole >= 2 && !student.subscription?.active && (
        <button className="btn mt10" onClick={() => setShowAssign(true)}>
          <Svg name="layers" size={17} /> Assign annual plan
        </button>
      )}

      {/* Subscription */}
      {student.subscription && (
        <div className="card pad mt16">
          <div className="between">
            <div className="h-sm">Subscription</div>
            <span className={`pill ${student.subscription.active ? "" : "amber"}`}>{student.subscription.active ? "Active" : "Pending"}</span>
          </div>
          <div className="kv mt8"><span className="k">Plan</span><span>{student.subscription.plan}</span></div>
          <div className="kv"><span className="k">Cycles used</span><span className="mono">{student.subscription.cyclesUsed} / {student.subscription.cyclesTotal}</span></div>
          <div className="kv"><span className="k">Per cycle</span><span>up to {student.subscription.kgPerCycle} kg</span></div>
          {student.subscription.expiresAt && (
            <div className="kv"><span className="k">Expires</span><span>{dateStr(student.subscription.expiresAt)}</span></div>
          )}
          {student.subscription.cycleLog.length > 0 && (
            <>
              <div className="divider" />
              <div className="label" style={{ marginBottom: 6 }}>Cycle usage</div>
              {student.subscription.cycleLog.slice(0, 8).map((c, i) => (
                <div key={i} className="kv" style={{ padding: "4px 0" }}>
                  <span className="k" style={{ fontSize: 13 }}>{dateStr(c.at)}</span>
                  <span className="muted" style={{ fontSize: 12.5 }}>{c.orderId ? "#" + c.orderId.slice(-4) : "1 cycle"}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Orders */}
      {student.orders.length > 0 && (
        <>
          <div className="sec-title mt20">Order history</div>
          {student.orders.slice(0, 12).map((o) => (
            <button key={o.id} className="card-btn mt10" onClick={() => router.push(`/s/orders/${o.id}`)}>
              <div className="grow">
                <div className="h-sm"># {o.id.slice(-4)}</div>
                <div className="muted mt4" style={{ fontSize: "13px" }}>{dateStr(o.createdAt)} · {fmt(o.total)}</div>
              </div>
              <span className={`pill st-${o.status}`}>{STATUS_LABEL[o.status] || o.status}</span>
            </button>
          ))}
        </>
      )}

      {/* Compensation history */}
      {student.compensations.length > 0 && (
        <>
          <div className="sec-title mt20">Compensation history</div>
          {student.compensations.map((c) => (
            <div key={c.id} className="card pad mt10">
              <div className="kv" style={{ padding: 0 }}>
                <span className="k">{KIND_LABEL[c.kind] || c.kind} · {c.method}</span>
                <span className="mono">{fmt(c.amount)}</span>
              </div>
              {c.comment && <div className="muted" style={{ fontSize: "12px", marginTop: "4px" }}>{c.comment}</div>}
              <div className="muted" style={{ fontSize: "11.5px", marginTop: "3px" }}>{timeAgo(c.at)}</div>
            </div>
          ))}
        </>
      )}

      {/* Credit usage */}
      {student.creditUses.length > 0 && (
        <>
          <div className="sec-title mt20">Credit usage</div>
          <div className="list">
            {student.creditUses.slice(0, 10).map((u) => (
              <div key={u.id} className="list-item">
                <div className="grow">
                  <div style={{ fontSize: 14 }}>{u.orderId ? "Used on order #" + u.orderId.slice(-4) : "Used towards a bill"}</div>
                  <div className="muted" style={{ fontSize: 12 }}>{dateStr(u.at)}</div>
                </div>
                <span className="mono" style={{ color: "var(--red)" }}>−{fmt(u.amount)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Compensation sheet */}
      {/* Assign annual plan (Manager+) */}
      <Sheet open={showAssign} onClose={() => setShowAssign(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>Assign annual plan</h2>
          <p className="muted" style={{ fontSize: "13px", marginBottom: "14px" }}>
            Activates immediately for {student.name}. Collect the payment first.
          </p>
          <div className="card pad" style={{ background: "var(--teal-tint)" }}>
            <div className="kv"><span className="k">Plan</span><span>Annual Plan</span></div>
            <div className="kv"><span className="k">Cycles</span><span className="mono">{plan.cycles} × up to {plan.kgPerCycle} kg</span></div>
            <div className="kv total"><span>To collect (incl. GST)</span><span className="mono">{fmt(plan.gross)}</span></div>
          </div>
          <div className="field mt16">
            <label>Paid by</label>
            <Seg<"cash" | "upi">
              options={[["upi", "UPI"], ["cash", "Cash"]]}
              value={assignMethod}
              onChange={setAssignMethod}
            />
          </div>
          <button className="btn mt16" onClick={doAssign} disabled={assignLoading}>
            <Svg name="check" size={18} /> {assignLoading ? "Activating…" : `Confirm ${fmt(plan.gross)} received & activate`}
          </button>
        </div>
      </Sheet>

      <Sheet open={showComp} onClose={() => setShowComp(false)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>Issue compensation</div>
        <div className="field">
          <label>Kind</label>
          <select className="input" value={comp.kind} onChange={(e) => setComp({ ...comp, kind: e.target.value })}>
            <option value="damage">Damage</option><option value="stain">Stain / re-do</option>
            <option value="missing">Missing item</option><option value="goodwill">Goodwill</option>
            <option value="manual">Adjustment</option>
          </select>
        </div>
        <div className="field">
          <label>Amount (₹)</label>
          <input className="input" type="number" value={comp.amount || ""} onChange={(e) => setComp({ ...comp, amount: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label>Method</label>
          <Seg<"credit" | "cash">
            options={staffRole >= 2 ? [["credit", "Store credit"], ["cash", "Cash"]] : [["credit", "Store credit"]]}
            value={comp.method}
            onChange={(m) => setComp({ ...comp, method: m })}
          />
        </div>
        <div className="field">
          <label>Comment</label>
          <input className="input" placeholder="Visible to the student" value={comp.comment} onChange={(e) => setComp({ ...comp, comment: e.target.value })} />
        </div>
        <button className="btn" onClick={doComp}><Svg name="gift" size={16} /> Issue compensation</button>
      </Sheet>
    </div>
  );
}
