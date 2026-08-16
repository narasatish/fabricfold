"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { Qr } from "@/components/qr";
import { fmt, dateStr, timeAgo, initials, STATUS_LABEL, loyaltyBadge } from "@/lib/format";
import { Seg, Sheet, Switch, useToast } from "@/components/chrome";
import { submitCompensation } from "@/lib/actions/credits";
import { assignSubscription, upgradeSubscription, cancelSubscription } from "@/lib/actions/subscription";
import { issueBag, retireBag, releaseBagCode } from "@/lib/actions/bags";
import { walkInOrder } from "@/lib/actions/orders";
import { enqueueIntake, newIdemKey } from "@/lib/offline-queue";
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

type CollegePlan = { id: string; name: string; tier: string | null; price: number; gross: number; gstApplies: boolean; buckets: { service: string; label: string; cycles: number; kgPerCycle: number }[] };

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
  // Mirrors issueBag: the free bag is a subscription perk, and a plan change
  // swaps the label free. A walk-in with no plan pays for theirs.
  const bagsNewestFirst = [...student.bags].sort((a, b) => b.issuedAt - a.issuedAt);
  const subscribedNow = !!student.subscription?.active;
  const hadFreeBag = student.bags.some((b) => b.complimentary);
  // Tier of the plan they're on NOW vs the tier stamped on their newest bag.
  const currentTier = subscribedNow
    ? (plans.find((p) => p.name === student.subscription!.plan)?.tier ?? null)
    : null;
  const lastBagTier = bagsNewestFirst[0]?.tier ?? null;
  const planTierChanged = bagsNewestFirst.length > 0 && lastBagTier !== currentTier;
  const bagIsFree = (subscribedNow && !hadFreeBag) || planTierChanged;
  const [showBag, setShowBag] = useState(false);
  const [bagPrice, setBagPrice] = useState(0);
  const [bagMethod, setBagMethod] = useState<"cash" | "upi">("cash");
  const [bagBusy, setBagBusy] = useState(false);

  const doIssueBag = async () => {
    setBagBusy(true);
    const r = await issueBag(student.id, { price: bagIsFree ? 0 : bagPrice, method: bagMethod });
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

  /* Release the customer ID back to the pool — the student has left the campus.
     Kept apart from "lost" and "replaced" because only this frees the code for
     somebody else, and the confirm spells out what that means. The action
     itself refuses while a plan or an open order is live. */
  const doReleaseBag = async (bagId: string, code: string) => {
    if (!confirm(
      `Release customer ID ${code}?\n\n` +
      `Use this when the student has left the campus. ${code} goes back into the pool and will be issued to a new student. ` +
      `Their past orders keep this code — only future issuing is affected.\n\n` +
      `For a bag that was lost or swapped on a plan change, use Lost or Replaced instead: those keep the code reserved.`,
    )) return;
    const r = await releaseBagCode(bagId);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast(`${r.code} released — free for a new student`);
    router.refresh();
  };

  // Change plan mid-term — pay only the difference, keep cycles already used
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [upgradePlanId, setUpgradePlanId] = useState("");
  const [upgradeMethod, setUpgradeMethod] = useState<"cash" | "upi">("cash");
  const [upgradeBusy, setUpgradeBusy] = useState(false);
  const currentPlanName = student.subscription?.plan || "";
  const upgradeOptions = plans.filter((p) => p.name !== currentPlanName);
  const upgradePlan = upgradeOptions.find((p) => p.id === upgradePlanId) || null;

  const doUpgrade = async () => {
    if (!upgradePlan) return;
    setUpgradeBusy(true);
    const r = await upgradeSubscription(student.id, upgradePlan.id, upgradeMethod);
    setUpgradeBusy(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast(`Moved to ${upgradePlan.name} — collected ${fmt(r.difference)}${r.tierChanged ? ". Issue a new bag for the new tier." : ""}`);
    setShowUpgrade(false);
    router.refresh();
  };

  // Cancel a plan (Admin+). The reason is mandatory and shown to the student.
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [cancelBusy, setCancelBusy] = useState(false);
  const cyclesLeft = student.subscription
    ? Math.max(0, student.subscription.cyclesTotal - student.subscription.cyclesUsed)
    : 0;

  const doCancel = async () => {
    setCancelBusy(true);
    const r = await cancelSubscription(student.id, cancelReason);
    setCancelBusy(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast(`Plan cancelled${r.cyclesForfeited ? ` — ${r.cyclesForfeited} cycle(s) forfeited` : ""}`);
    setShowCancel(false);
    setCancelReason("");
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
    const intake = {
      studentId: student.id,
      studentLabel: student.name,
      service: wiService,
      items: wiItems.map(([label]) => ({ label, qty: wiQty[label] || 0 })).filter((i) => i.qty > 0),
      weightKg: wiWeight || null,
      useCycle: wiUseCycle,
      noGst: wiNoGst,
      express: wiExpress,
    };

    /* No connection: save it and let the student go.
       Checked BEFORE calling, because a server action with no network hangs
       and then throws — the staff member would be left holding a bag with no
       idea whether it registered. */
    if (typeof navigator !== "undefined" && !navigator.onLine) {
      enqueueIntake(intake);
      setShowWalkIn(false);
      setWiQty({});
      toast("Saved on this device — it will send when the connection returns");
      return;
    }

    setWiLoading(true);
    /* The key travels with the request so a retry after a TIMEOUT cannot book
       the same bag in twice: the server may well have committed before the
       connection died. */
    const idemKey = newIdemKey();
    let r: Awaited<ReturnType<typeof walkInOrder>> | null = null;
    try {
      r = await walkInOrder(student.id, { ...intake, idemKey });
    } catch {
      /* Thrown, not returned — the network died mid-flight. Whether the server
         committed is unknowable from here, which is exactly what the key is
         for: queue it, and the replay resolves to the same single order. */
      enqueueIntake({ ...intake, idemKey });
      setWiLoading(false);
      setShowWalkIn(false);
      setWiQty({});
      toast("Connection lost — order saved on this device and will send itself", true);
      return;
    }
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
          <div className="row wrap gap8 mt12">
            {staffRole >= 2 && upgradeOptions.length > 0 && (
              <button className="btn xs sec" onClick={() => { setUpgradePlanId(upgradeOptions[0].id); setShowUpgrade(true); }}>
                <Svg name="layers" size={13} /> Change plan
              </button>
            )}
            {staffRole >= 3 && student.subscription.active && (
              <button className="btn xs sec" onClick={() => setShowCancel(true)}>
                <Svg name="x" size={13} /> Cancel plan
              </button>
            )}
          </div>
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
                  <button className="btn xs sec" style={{ color: "var(--red)" }} onClick={() => doReleaseBag(activeBag.id, activeBag.code)}>
                    Student left
                  </button>
                </div>
                <div className="muted mt8" style={{ fontSize: 11.5 }}>
                  Lost or replaced frees the student for a new code, but keeps the old one reserved — a bag
                  handed in months later must still name its owner. <strong>Student left</strong> is the only
                  one that returns {activeBag.code} to the pool for a new student.
                </div>
              </>
            ) : (
              <>
                <div className="muted" style={{ fontSize: 13 }}>
                  {bagIsFree
                    ? "No bag issued yet — complimentary with their plan."
                    : subscribedNow
                      ? "No active bag. Issue a replacement below."
                      : "No active bag. Walk-in bags are sold — the free one comes with a plan."}
                </div>
                <button className="btn xs mt12" onClick={() => setShowBag(true)}>
                  <Svg name="plus" size={13} /> {bagIsFree ? "Issue complimentary bag" : "Sell a bag"}
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

      {/* Cancel a plan (Admin+) */}
      <Sheet open={showCancel} onClose={() => setShowCancel(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>Cancel plan</h2>
          <div className="muted" style={{ fontSize: "12.5px", marginBottom: "14px" }}>
            Ends &quot;{student.subscription?.plan}&quot; immediately. The reason is sent to the student
            and kept on record.
          </div>

          {cyclesLeft > 0 && (
            <div className="card pad" style={{ background: "var(--amber-soft)", borderColor: "#f2e2c4", marginBottom: "14px" }}>
              <span style={{ fontSize: "12.5px", color: "var(--amber)" }}>
                {cyclesLeft} unused cycle{cyclesLeft === 1 ? "" : "s"} will be forfeited. Cancelling refunds
                nothing on its own — issue a refund or compensation separately if money is owed back.
              </span>
            </div>
          )}

          <div className="field">
            <label>Reason <span style={{ color: "var(--red)" }}>*</span></label>
            <textarea
              className="input"
              rows={3}
              placeholder="e.g. Student left the campus mid-term"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
          </div>

          <button className="btn mt12" onClick={doCancel} disabled={cancelBusy || cancelReason.trim().length < 3}>
            <Svg name="check" size={18} /> {cancelBusy ? "Cancelling…" : "Cancel this plan"}
          </button>
        </div>
      </Sheet>

      {/* Change plan mid-term */}
      <Sheet open={showUpgrade} onClose={() => setShowUpgrade(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>Change plan</h2>
          <div className="muted" style={{ fontSize: "12.5px", marginBottom: "16px" }}>
            Only the price difference is collected. Cycles they&apos;ve already used stay used —
            moving plan doesn&apos;t hand back washes they&apos;ve had.
          </div>
          <div className="field">
            <label>New plan</label>
            <select className="input" style={{ height: 42 }} value={upgradePlanId} onChange={(e) => setUpgradePlanId(e.target.value)}>
              {upgradeOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.name} — {fmt(p.gross)}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Payment method</label>
            <Seg<"cash" | "upi"> options={[["cash", "Cash"], ["upi", "UPI"]]} value={upgradeMethod} onChange={setUpgradeMethod} />
          </div>
          <div className="muted" style={{ fontSize: 12, marginBottom: 12 }}>
            A downgrade is refused here — handle refunds at the counter rather than automatically.
            If the tier letter changes, issue a new bag afterwards (that swap is free).
          </div>
          <button className="btn" onClick={doUpgrade} disabled={upgradeBusy || !upgradePlan}>
            <Svg name="check" size={18} /> {upgradeBusy ? "Saving…" : "Collect difference & change plan"}
          </button>
        </div>
      </Sheet>

      {/* Issue / sell a bag */}
      <Sheet open={showBag} onClose={() => setShowBag(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>{bagIsFree ? "Issue complimentary bag" : "Sell a bag"}</h2>
          <div className="muted" style={{ fontSize: "12.5px", marginBottom: "16px" }}>
            The code is allocated automatically from {student.subscription?.active ? "their plan tier" : "the walk-in series"} and
            printed on the bag. It is never reused, so write it on the bag before handing it over.
          </div>
          {!bagIsFree && (
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
          <button className="btn" onClick={doIssueBag} disabled={bagBusy || (!bagIsFree && bagPrice <= 0)}>
            <Svg name="check" size={18} /> {bagBusy ? "Issuing…" : bagIsFree ? "Issue bag" : `Take ${fmt(bagPrice)} & issue`}
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
