"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { Qr } from "@/components/qr";
import { fmt, dateStr, timeAgo, initials, STATUS_LABEL, loyaltyBadge } from "@/lib/format";
import { Seg, Sheet, Switch, useToast } from "@/components/chrome";
import { submitCompensation } from "@/lib/actions/credits";
import { assignSubscription } from "@/lib/actions/subscription";
import { issueBag, retireBag } from "@/lib/actions/bags";
import { walkInOrder } from "@/lib/actions/orders";
import { topUpCredits } from "@/lib/actions/ops";
import { updateStudentPhone } from "@/lib/actions/admin";

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
  bags: { id: string; code: string; tier: string | null; complimentary: boolean; price: number; status: string; issuedAt: number }[];
  orders: { id: string; status: string; service: string; total: number; createdAt: number }[];
  compensations: { id: string; kind: string; amount: number; method: string; comment: string | null; at: number }[];
  creditUses: { id: string; amount: number; orderId: string; at: number }[];
};

const KIND_LABEL: Record<string, string> = { damage: "Damage", stain: "Stain / re-do", missing: "Missing item", goodwill: "Goodwill", manual: "Adjustment" };

type CollegePlan = { id: string; name: string; price: number; gross: number; gstApplies: boolean; buckets: { service: string; label: string; cycles: number; kgPerCycle: number }[] };

type Rates = Record<string, { label: string; items: [string, number][] }>;

export default function StaffCustomerClient({ student, staffRole, plans, rates, gstEnabled }: { student: Student; staffRole: number; plans: CollegePlan[]; rates: Rates; gstEnabled: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const tier = loyaltyBadge(student.lifetimePieces);
  const [showPhoneEdit, setShowPhoneEdit] = useState(false);
  const [newPhone, setNewPhone] = useState(student.phone);
  const [phoneLoading, setPhoneLoading] = useState(false);
  const [showComp, setShowComp] = useState(false);
  const [comp, setComp] = useState({ kind: "damage", amount: 0, method: "credit" as "credit" | "cash", comment: "" });
  const [showAssign, setShowAssign] = useState(false);
  const [assignPlanId, setAssignPlanId] = useState(plans[0]?.id || "");
  const [assignMethod, setAssignMethod] = useState<"cash" | "upi">("upi");
  const [assignLoading, setAssignLoading] = useState(false);
  const assignPlan = plans.find((p) => p.id === assignPlanId) || plans[0];

  // Walk-in order (student at the counter without a booking)
  const serviceKeys = Object.keys(rates);
  const [showWalkIn, setShowWalkIn] = useState(false);
  const [wiService, setWiService] = useState(serviceKeys[0] || "washIron");
  const [wiQty, setWiQty] = useState<Record<string, number>>({});
  const [wiWeight, setWiWeight] = useState(0);
  const [wiUseCycle, setWiUseCycle] = useState(false);
  const [wiNoGst, setWiNoGst] = useState(false);
  const [wiExpress, setWiExpress] = useState(false);
  const [wiLoading, setWiLoading] = useState(false);
  const wiItems = rates[wiService]?.items || [];
  const wiSubtotal = wiItems.reduce((s, [label, price]) => s + price * (wiQty[label] || 0), 0);
  const wiPieces = wiItems.reduce((s, [label]) => s + (wiQty[label] || 0), 0);
  const wiGst = wiUseCycle || wiNoGst || !gstEnabled ? 0 : Math.round((wiSubtotal + (wiExpress ? Math.round(wiSubtotal * 0.4) : 0)) * 0.18);
  const wiExpressSurcharge = wiExpress && !wiUseCycle ? Math.round(wiSubtotal * 0.4) : 0;
  const subHasCycles = !!student.subscription?.active;

  // Bags — first is complimentary, replacements are sold at the counter
  const activeBag = student.bags.find((b) => b.status === "active") || null;
  const isFirstBag = student.bags.length === 0;
  const [showBag, setShowBag] = useState(false);
  const [bagPrice, setBagPrice] = useState(0);
  const [bagMethod, setBagMethod] = useState<"cash" | "upi">("cash");
  const [bagBusy, setBagBusy] = useState(false);

  const doIssueBag = async () => {
    setBagBusy(true);
    const r = await issueBag(student.id, { price: isFirstBag ? 0 : bagPrice, method: bagMethod });
    setBagBusy(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast(`Bag ${r.code} issued${r.complimentary ? " — complimentary" : ` · ₹${r.price}`}`);
    setShowBag(false);
    setBagPrice(0);
    router.refresh();
  };

  const doRetireBag = async (bagId: string, status: "lost" | "replaced") => {
    const r = await retireBag(bagId, status);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast(`Bag marked ${status}`);
    router.refresh();
  };

  // Wallet top-up (money physically received first)
  const [showTopUp, setShowTopUp] = useState(false);
  const [tuAmount, setTuAmount] = useState(0);
  const [tuMethod, setTuMethod] = useState<"cash" | "upi">("upi");
  const [tuLoading, setTuLoading] = useState(false);
  const doTopUp = async () => {
    setTuLoading(true);
    const r = await topUpCredits(student.id, tuAmount, tuMethod);
    setTuLoading(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast(`₹${tuAmount} added to wallet`);
    setShowTopUp(false);
    setTuAmount(0);
    router.refresh();
  };

  const doWalkIn = async () => {
    setWiLoading(true);
    const r = await walkInOrder(student.id, {
      service: wiService,
      items: wiItems.map(([label]) => ({ label, qty: wiQty[label] || 0 })),
      weightKg: wiWeight || null,
      useCycle: wiUseCycle,
      noGst: wiNoGst,
      express: wiExpress,
    });
    setWiLoading(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast(`Walk-in order #${r.id?.slice(-4)} created`);
    setShowWalkIn(false);
    setWiQty({});
    router.push(`/s/orders/${r.id}`);
  };

  const doAssign = async () => {
    if (!assignPlan) return;
    setAssignLoading(true);
    const r = await assignSubscription(student.id, assignPlan.id, assignMethod);
    setAssignLoading(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast("Plan activated");
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

  // Students have no self-service way to change their number — they come to
  // the counter and an Admin makes the change here.
  const doPhoneChange = async () => {
    setPhoneLoading(true);
    const r = await updateStudentPhone(student.id, newPhone);
    setPhoneLoading(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast("Phone number updated");
    setShowPhoneEdit(false);
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
            <div className="row gap8" style={{ alignItems: "center" }}>
              <div className="muted" style={{ fontSize: "12px" }}>+91 {student.phone}</div>
              {staffRole >= 3 && (
                <button
                  className="action"
                  style={{ padding: "2px 6px" }}
                  aria-label="Change phone number"
                  onClick={() => { setNewPhone(student.phone); setShowPhoneEdit(true); }}
                >
                  <Svg name="edit" size={13} />
                </button>
              )}
            </div>
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

      <button className="btn mt12" onClick={() => setShowWalkIn(true)}>
        <Svg name="plus" size={17} /> New walk-in order
      </button>

      <div className="row gap8 mt10">
        <button className="btn ghost" onClick={() => setShowTopUp(true)}>
          <Svg name="wallet" size={17} /> Add money
        </button>
        <button className="btn ghost" onClick={() => setShowComp(true)}>
          <Svg name="gift" size={17} /> Compensation
        </button>
      </div>

      {staffRole >= 2 && !student.subscription?.active && plans.length > 0 && (
        <button className="btn mt10" onClick={() => setShowAssign(true)}>
          <Svg name="layers" size={17} /> Assign a plan
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
          <div className="sec-title mt20">Bag</div>
          <div className="card pad mt10">
            {activeBag ? (
              <>
                <div className="between">
                  <span className="h-sm mono" style={{ fontSize: 18 }}>{activeBag.code}</span>
                  <span className="pill">{activeBag.complimentary ? "Complimentary" : fmt(activeBag.price)}</span>
                </div>
                <div className="muted mt4" style={{ fontSize: 12 }}>Issued {dateStr(activeBag.issuedAt)}</div>
                <div className="row gap8 mt12">
                  <button className="btn xs sec" onClick={() => doRetireBag(activeBag.id, "lost")}>Mark lost</button>
                  <button className="btn xs sec" onClick={() => doRetireBag(activeBag.id, "replaced")}>Mark replaced</button>
                </div>
                <div className="muted mt8" style={{ fontSize: 11.5 }}>
                  Retiring a bag frees the student for a new code. The old code is never reissued.
                </div>
              </>
            ) : (
              <>
                <div className="muted" style={{ fontSize: 13 }}>
                  {isFirstBag ? "No bag issued yet — the first one is complimentary." : "No active bag. Issue a replacement below."}
                </div>
                <button className="btn xs mt12" onClick={() => setShowBag(true)}>
                  <Svg name="plus" size={13} /> {isFirstBag ? "Issue complimentary bag" : "Sell a replacement bag"}
                </button>
              </>
            )}
            {student.bags.filter((b) => b.status !== "active").length > 0 && (
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--line)" }}>
                {student.bags.filter((b) => b.status !== "active").map((b) => (
                  <div key={b.id} className="kv">
                    <span className="k mono">{b.code}</span>
                    <span className="muted" style={{ fontSize: 12 }}>{b.status} · {dateStr(b.issuedAt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

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
      {/* Wallet top-up sheet */}
      <Sheet open={showTopUp} onClose={() => setShowTopUp(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>Add money to wallet</h2>
          <p className="muted" style={{ fontSize: "13px", marginBottom: "14px" }}>
            Collect the money first — it becomes spendable credit for {student.name}.
          </p>
          <div className="field">
            <label>Amount (₹)</label>
            <input className="input" type="number" inputMode="numeric" placeholder="e.g. 500" value={tuAmount || ""} onChange={(e) => setTuAmount(Number(e.target.value))} />
          </div>
          <div className="field">
            <label>Received by</label>
            <Seg<"cash" | "upi"> options={[["upi", "UPI"], ["cash", "Cash"]]} value={tuMethod} onChange={setTuMethod} />
          </div>
          <button className="btn mt12" onClick={doTopUp} disabled={tuLoading || !tuAmount}>
            <Svg name="check" size={18} /> {tuLoading ? "Adding…" : `Confirm ₹${tuAmount || 0} received`}
          </button>
        </div>
      </Sheet>

      {/* Walk-in order sheet */}
      <Sheet open={showWalkIn} onClose={() => setShowWalkIn(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>New walk-in order</h2>
          <p className="muted" style={{ fontSize: "13px", marginBottom: "14px" }}>
            Counted &amp; tagged in one step — for students who didn&apos;t pre-book.
          </p>
          <div className="field">
            <label>Service</label>
            <select className="input" value={wiService} onChange={(e) => { setWiService(e.target.value); setWiQty({}); }}>
              {serviceKeys.map((k) => <option key={k} value={k}>{rates[k].label}</option>)}
            </select>
          </div>
          {wiItems.map(([label, price]) => (
            <div key={label} className="between" style={{ padding: "7px 0" }}>
              <span style={{ fontSize: 14 }}>{label} <span className="muted" style={{ fontSize: 12 }}>₹{price}</span></span>
              <div className="step"><div className="qty">
                <button onClick={() => setWiQty({ ...wiQty, [label]: Math.max(0, (wiQty[label] || 0) - 1) })}>−</button>
                <span>{wiQty[label] || 0}</span>
                <button onClick={() => setWiQty({ ...wiQty, [label]: (wiQty[label] || 0) + 1 })}>+</button>
              </div></div>
            </div>
          ))}
          <div className="field mt8">
            <label>Weight (kg)</label>
            <input className="input" type="number" step="0.1" value={wiWeight || ""} onChange={(e) => setWiWeight(Number(e.target.value))} />
          </div>
          {subHasCycles && (
            <div className="chip-toggle" style={{ marginBottom: "12px" }}>
              <div>
                <div className="h-sm">Use a plan cycle</div>
                <div className="muted" style={{ fontSize: "12px" }}>Burns a {rates[wiService]?.label} cycle from their plan</div>
              </div>
              <Switch on={wiUseCycle} onToggle={() => setWiUseCycle(!wiUseCycle)} />
            </div>
          )}
          {!wiUseCycle && gstEnabled && (
            <div className="chip-toggle" style={{ marginBottom: "12px" }}>
              <div>
                <div className="h-sm">Bill without GST</div>
                <div className="muted" style={{ fontSize: "12px" }}>Recorded, no tax invoice</div>
              </div>
              <Switch on={wiNoGst} onToggle={() => setWiNoGst(!wiNoGst)} />
            </div>
          )}
          <div className="chip-toggle" style={{ marginBottom: "12px" }}>
            <div>
              <div className="h-sm">Urgent (same day)</div>
              <div className="muted" style={{ fontSize: "12px" }}>
                {wiUseCycle ? "Cycle already covers the wash — only a 40% premium on its per-cycle value is charged, in cash" : "+40% of the order value"}
              </div>
            </div>
            <Switch on={wiExpress} onToggle={() => setWiExpress(!wiExpress)} />
          </div>
          <div className="card pad" style={{ background: "var(--teal-tint)" }}>
            <div className="kv"><span className="k">Pieces</span><span className="mono">{wiPieces}</span></div>
            <div className="kv"><span className="k">Subtotal</span><span className="mono">{fmt(wiSubtotal)}</span></div>
            {wiUseCycle ? (
              <div className="kv total"><span>{wiExpress ? "Cycle covered + urgent cash premium" : "Covered by plan cycle"}</span><span className="mono">{wiExpress ? "cash on collection" : fmt(0)}</span></div>
            ) : (
              <div className="kv total"><span>Est. total</span><span className="mono">{fmt(wiSubtotal + wiExpressSurcharge + wiGst)}</span></div>
            )}
          </div>
          <button className="btn mt16" onClick={doWalkIn} disabled={wiLoading || wiPieces === 0}>
            <Svg name="check" size={18} /> {wiLoading ? "Creating…" : "Create & receive order"}
          </button>
        </div>
      </Sheet>

      {/* Issue / sell a bag */}
      <Sheet open={showBag} onClose={() => setShowBag(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>{isFirstBag ? "Issue complimentary bag" : "Sell a replacement bag"}</h2>
          <div className="muted" style={{ fontSize: "12.5px", marginBottom: "16px" }}>
            The code is allocated automatically from {student.subscription?.active ? "their plan tier" : "the walk-in series"} and
            printed on the bag. It is never reused, so write it on the bag before handing it over.
          </div>
          {!isFirstBag && (
            <>
              <div className="field">
                <label>Price</label>
                <input className="input" type="number" value={bagPrice || ""} onChange={(e) => setBagPrice(Number(e.target.value))} />
              </div>
              <div className="field">
                <label>Payment method</label>
                <Seg<"cash" | "upi"> options={[["cash", "Cash"], ["upi", "UPI"]]} value={bagMethod} onChange={setBagMethod} />
              </div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
                Posts as a counter payment, so it lands in today&apos;s cash reconciliation.
              </div>
            </>
          )}
          <button className="btn" onClick={doIssueBag} disabled={bagBusy || (!isFirstBag && bagPrice <= 0)}>
            <Svg name="check" size={18} /> {bagBusy ? "Issuing…" : isFirstBag ? "Issue bag" : `Take ${fmt(bagPrice)} & issue`}
          </button>
        </div>
      </Sheet>

      {/* Assign a plan (Manager+) */}
      <Sheet open={showAssign} onClose={() => setShowAssign(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>Assign a plan</h2>
          <p className="muted" style={{ fontSize: "13px", marginBottom: "14px" }}>
            Activates immediately for {student.name}. Collect the payment first.
          </p>
          <div className="field">
            <label>Plan ({student.college?.name})</label>
            <select className="input" value={assignPlanId} onChange={(e) => setAssignPlanId(e.target.value)}>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {fmt(p.gross)}</option>
              ))}
            </select>
          </div>
          {assignPlan && (
            <div className="card pad" style={{ background: "var(--teal-tint)" }}>
              {assignPlan.buckets.map((b) => (
                <div key={b.service} className="kv"><span className="k">{b.label}</span><span className="mono">{b.cycles} × {b.kgPerCycle} kg</span></div>
              ))}
              <div className="kv total"><span>To collect{assignPlan.gstApplies ? " (incl. GST)" : ""}</span><span className="mono">{fmt(assignPlan.gross)}</span></div>
            </div>
          )}
          <div className="field mt16">
            <label>Paid by</label>
            <Seg<"cash" | "upi">
              options={[["upi", "UPI"], ["cash", "Cash"]]}
              value={assignMethod}
              onChange={setAssignMethod}
            />
          </div>
          <button className="btn mt16" onClick={doAssign} disabled={assignLoading || !assignPlan}>
            <Svg name="check" size={18} /> {assignLoading ? "Activating…" : `Confirm ${fmt(assignPlan?.gross || 0)} received & activate`}
          </button>
        </div>
      </Sheet>

      <Sheet open={showPhoneEdit} onClose={() => setShowPhoneEdit(false)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>Change registered number</div>
        <div className="muted" style={{ fontSize: "12.5px", padding: "0 4px 14px" }}>
          Students can't change this themselves — verify their identity before updating it.
        </div>
        <div className="field">
          <label>New mobile number</label>
          <input
            className="input"
            inputMode="numeric"
            maxLength={10}
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
          />
        </div>
        <button className="btn" onClick={doPhoneChange} disabled={phoneLoading || newPhone.length !== 10}>
          {phoneLoading ? "Saving…" : "Save new number"}
        </button>
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
