"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { Qr } from "@/components/qr";
import { fmt, dateStr, timeAgo, initials, STATUS_LABEL, upiLink } from "@/lib/format";
import { CYCLE_KG_LIMIT, CYCLE_RATES, isCycleService, excessWeightCharge } from "@/lib/money";
import { isOverdue } from "@/lib/money";
import { useToast, Sheet, Seg, Switch } from "@/components/chrome";
import {
  acceptOrder,
  advanceStatus,
  collectOrder,
  recordPay,
  refundOrder,
  redoOrder,
  cancelOrder,
  scanTag,
} from "@/lib/actions/orders";
import { submitCompensation } from "@/lib/actions/credits";
import { reportOrderDamage } from "@/lib/actions/complaints";
import { MIN_DAMAGE_PHOTOS } from "@/lib/complaint-rules";
import { compressImage } from "@/lib/compress-image";
import { WEEKDAY_NAMES, isOffWashDay } from "@/lib/washday";

type Order = {
  id: string;
  studentId: string;
  collegeId: string;
  status: string;
  service: string;
  items: Array<{ label: string; rate: number; qty: number }>;
  actualPieces: number | null;
  declaredPieces: number | null;
  weightKg: number | null;
  cyclesCount: number;
  express: boolean;
  surcharge: number;
  subtotal: number;
  gst: number;
  gstPct: number;
  total: number;
  paid: boolean;
  paymentMethod: string | null;
  creditApplied: number;
  usedCycle: boolean;
  noGst: boolean;
  intakePhotos: string[];
  refunded: boolean;
  refundAmount: number;
  redoOfId: string | null;
  rating: number | null;
  ratingComment: string | null;
  createdAt: number;
  receivedAt: number | null;
  timeline: Array<{ status: string; at: number }>;
  tags: Array<{ code: string; label: string; scanned: boolean }>;
  received: number;
  student: {
    id: string; name: string; phone: string; credits: number; lifetimePieces: number;
    washDay: number | null;
    subscription: { active: boolean; cyclesTotal: number; cyclesUsed: number; kgPerCycle: number } | null;
  };
  college: { id: string; name: string } | null;
  invoice: { number: string } | null;
};

export default function StaffOrderClient({
  order,
  serviceRates,
  staffRole,
  upi,
  expectedPickupCode,
  baseGarmentRate,
}: {
  order: Order;
  serviceRates: { label: string; items: Array<[string, number]> };
  staffRole: number;
  upi: { upiId: string; payeeName: string };
  expectedPickupCode: string | null;
  baseGarmentRate: number;
}) {
  const router = useRouter();
  const toast = useToast();

  const [showAcceptSheet, setShowAcceptSheet] = useState(false);
  const [showCollectSheet, setShowCollectSheet] = useState(false);
  const [showPaymentSheet, setShowPaymentSheet] = useState(false);
  const [showRefundSheet, setShowRefundSheet] = useState(false);
  const [showCompensationSheet, setShowCompensationSheet] = useState(false);
  const [showPrintSheet, setShowPrintSheet] = useState(false);
  const [showUpiSheet, setShowUpiSheet] = useState(false);

  /* A subscriber's order defaults to USING their plan.

     This defaulted to false, so every cycle order depended on the counter
     remembering to flick a toggle. Forget it and the student is billed the
     full per-piece price despite holding a plan they paid for — and, because
     the weight allowance only applies to cycle orders, no excess is worked out
     either. That is the "it just asks for the weight and nothing happens" the
     owner hit. Staff can still turn it off for a student who wants to pay
     per piece and keep the cycle. */
  const subCyclesLeft = order.student.subscription
    ? order.student.subscription.cyclesTotal - order.student.subscription.cyclesUsed
    : 0;
  const canUseCycle = !!order.student.subscription?.active && subCyclesLeft > 0;

  // Sheet state
  const cycleBased = isCycleService(order.service);
  const [acceptInput, setAcceptInput] = useState({ weightKg: order.weightKg || 0, cycles: Math.max(1, order.cyclesCount || 1), useCycle: canUseCycle, noGst: false, waiveExcess: false, itemQtys: {} as Record<string, number> });
  /* The weight field holds a STRING while being typed — see the input below. */
  const [weightText, setWeightText] = useState(order.weightKg ? String(order.weightKg) : "");
  /* Previewed with the same function that bills it, so the number staff quote
     at the counter is the number the order is charged. */
  const allowanceKg = CYCLE_KG_LIMIT * (cycleBased ? acceptInput.cycles : 1);
  const overKg = Math.max(0, (acceptInput.weightKg || 0) - allowanceKg);
  const excessNow = excessWeightCharge(acceptInput.weightKg, undefined, { waived: acceptInput.waiveExcess, cycles: cycleBased ? acceptInput.cycles : 1 });
  const [intakePhotos, setIntakePhotos] = useState<string[]>([]);
  // Damage report — opens a complaint thread the student can see, so it needs
  // real evidence attached before it can be filed.
  const [showDamage, setShowDamage] = useState(false);
  const [damagePhotos, setDamagePhotos] = useState<string[]>([]);
  const [damageComment, setDamageComment] = useState("");
  const [damageBusy, setDamageBusy] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [collectCode, setCollectCode] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<"cash" | "upi">("cash");
  const [applyCredits, setApplyCredits] = useState(false);
  const [staffInvoice, setStaffInvoice] = useState(false);
  const [refundInput, setRefundInput] = useState({ amount: order.received || order.total, via: "upi" as "upi" | "cash" | "credit", reason: "", restoreCycle: false });
  const [compInput, setCompInput] = useState({ kind: "damage", amount: 0, method: "credit" as "credit" | "cash", comment: "" });
  // Recount before handing over. Missing items are the commonest complaint and
  // the cheapest moment to catch one is before the student opens the bag.
  const intakeCount = order.actualPieces ?? order.declaredPieces ?? 0;
  const [showReady, setShowReady] = useState(false);
  const [countedPieces, setCountedPieces] = useState<number>(intakeCount);
  const [readyBusy, setReadyBusy] = useState(false);

  const late = isOverdue({ status: order.status, receivedAt: order.receivedAt ? new Date(order.receivedAt) : null, express: order.express }) && (order.status === "received" || order.status === "processing");
  const isDraft = order.status === "draft";
  const redoOf = order.redoOfId;
  const creditCover = Math.min(order.student.credits, order.total);
  const remaining = order.total - (applyCredits ? creditCover : 0);

  // Handler: accept order
  const handleAccept = async () => {
    const adjusted = serviceRates.items
      .filter((it) => acceptInput.itemQtys[it[0]] > 0)
      .map((it) => ({ label: it[0], qty: acceptInput.itemQtys[it[0]] }));
    const r = await acceptOrder(order.id, {
      weightKg: acceptInput.weightKg || null,
      cycles: cycleBased ? acceptInput.cycles : undefined,
      useCycle: acceptInput.useCycle,
      noGst: acceptInput.noGst,
      waiveExcess: acceptInput.waiveExcess,
      items: adjusted.length ? adjusted : undefined,
      intakePhotos: intakePhotos.length ? intakePhotos : undefined,
    });
    if (!r.ok) {
      toast(r.error || "Failed", true);
      return;
    }
    toast("Order accepted");
    setShowAcceptSheet(false);
    router.refresh();
  };

  // Handler: upload a damage/intake photo
  const handleIntakePhoto = async (file: File) => {
    if (intakePhotos.length >= 6) {
      toast("Up to 6 photos", true);
      return;
    }
    setUploadingPhoto(true);
    try {
      const fd = new FormData();
      // shrink on-device first: a raw phone photo is 3-12 MB, which is slow to
      // upload and was exhausting serverless memory on the receiving end
      const { file: upload } = await compressImage(file);
      fd.append("file", upload);
      const res = await fetch("/api/upload/intake", { method: "POST", body: fd });
      if (!res.ok) {
        toast(await res.text() || "Upload failed", true);
        return;
      }
      const j = (await res.json()) as { key: string };
      setIntakePhotos((p) => [...p, j.key]);
    } catch {
      toast("Upload failed", true);
    } finally {
      setUploadingPhoto(false);
    }
  };

  // Handler: upload a photo for the damage report (same store as intake)
  const handleDamagePhoto = async (file: File) => {
    setUploadingPhoto(true);
    try {
      const fd = new FormData();
      // shrink on-device first: a raw phone photo is 3-12 MB, which is slow to
      // upload and was exhausting serverless memory on the receiving end
      const { file: upload } = await compressImage(file);
      fd.append("file", upload);
      const res = await fetch("/api/upload/intake", { method: "POST", body: fd });
      if (!res.ok) {
        toast((await res.text()) || "Upload failed", true);
        return;
      }
      const j = (await res.json()) as { key: string };
      setDamagePhotos((p) => [...p, j.key]);
    } catch {
      toast("Upload failed", true);
    } finally {
      setUploadingPhoto(false);
    }
  };

  const submitDamage = async () => {
    setDamageBusy(true);
    const r = await reportOrderDamage(order.id, { comment: damageComment, photos: damagePhotos });
    setDamageBusy(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast("Damage reported — the student has been notified");
    setShowDamage(false);
    setDamagePhotos([]);
    setDamageComment("");
    router.refresh();
  };

  // Handler: advance status
  const confirmReady = async () => {
    setReadyBusy(true);
    const r = await advanceStatus(order.id, { countedPieces });
    setReadyBusy(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast(countedPieces < intakeCount ? `Marked ready — shortfall of ${intakeCount - countedPieces} flagged` : "Marked ready for collection");
    setShowReady(false);
    router.refresh();
  };

  const handleAdvance = async () => {
    // Going to ready goes through the recount prompt instead.
    if (order.status === "processing") return setShowReady(true);
    const r = await advanceStatus(order.id);
    if (!r.ok) {
      toast(r.error || "Failed", true);
      return;
    }
    toast("Status updated");
    router.refresh();
  };

  // Handler: collect order
  const handleCollect = async () => {
    const r = await collectOrder(order.id, collectCode);
    if (!r.ok) {
      toast(r.error || "Failed", true);
      return;
    }
    toast("Order collected");
    setShowCollectSheet(false);
    router.refresh();
  };

  // Handler: record payment (cash)
  const handlePayCash = async () => {
    const r = await recordPay(order.id, "cash", applyCredits, staffInvoice);
    if (!r.ok) {
      toast(r.error || "Failed", true);
      return;
    }
    toast("Payment recorded");
    setShowPaymentSheet(false);
    router.refresh();
  };

  // Handler: record payment (UPI) — after QR display
  const handlePayUpi = async () => {
    const r = await recordPay(order.id, "upi", applyCredits, staffInvoice);
    if (!r.ok) {
      toast(r.error || "Failed", true);
      return;
    }
    toast("Payment marked received");
    setShowUpiSheet(false);
    setShowPaymentSheet(false);
    router.refresh();
  };

  // Handler: refund
  const handleRefund = async () => {
    const r = await refundOrder(order.id, refundInput.amount, refundInput.via, refundInput.reason, refundInput.restoreCycle);
    if (!r.ok) {
      toast(r.error || "Failed", true);
      return;
    }
    toast("Refund processed");
    setShowRefundSheet(false);
    router.refresh();
  };

  // Handler: compensation
  const handleCompensation = async () => {
    const r = await submitCompensation({
      studentId: order.studentId,
      orderId: order.id,
      kind: compInput.kind,
      amount: compInput.amount,
      method: compInput.method,
      comment: compInput.comment,
    });
    if (!r.ok) {
      toast(r.error || "Failed", true);
      return;
    }
    toast("Compensation issued");
    setShowCompensationSheet(false);
    router.refresh();
  };

  // Handler: redo
  const handleRedo = async () => {
    if (!confirm("Create a free re-do of this order?")) return;
    const r = await redoOrder(order.id);
    if (!r.ok) {
      toast(r.error || "Failed", true);
      return;
    }
    toast("Re-do order created");
    router.push(`/s/orders/${r.id}`);
  };

  // Handler: cancel
  const handleCancel = async () => {
    if (!confirm("Cancel this order? This cannot be undone.")) return;
    const r = await cancelOrder(order.id);
    if (!r.ok) {
      toast(r.error || "Failed", true);
      return;
    }
    toast("Order cancelled");
    router.push("/s");
  };

  // Handler: scan tag
  const handleScanTag = async (code: string) => {
    const r = await scanTag(order.id, code);
    if (!r.ok) {
      toast(r.error || "Failed", true);
      return;
    }
    router.refresh();
  };

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
            ID {order.studentId} · {order.student.lifetimePieces} pcs lifetime
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
          <span className="k">{order.noGst || order.gstPct === 0 ? "GST — not charged" : `GST (${order.gstPct}%)`}</span>
          <span className="mono">{fmt(Number(order.gst))}</span>
        </div>
        <div className="kv total">
          <span>Total</span>
          <span className="mono">{fmt(Number(order.total))}</span>
        </div>
      </div>

      {/* Raise a damage report the student can see, with evidence attached */}
      <button className="card-btn mt12" onClick={() => setShowDamage(true)}>
        <div className="icon-tile" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
          <Svg name="alert" size={20} />
        </div>
        <div className="grow">
          <div className="h-sm">Report damage on these clothes</div>
          <div className="muted" style={{ fontSize: 12 }}>
            Needs {MIN_DAMAGE_PHOTOS}+ photos and a note · sent to the student
          </div>
        </div>
        <Svg name="chevR" size={18} />
      </button>

      {/* Intake / damage photos */}
      {order.intakePhotos.length > 0 && (
        <div className="card pad mt12">
          <div className="sec-title" style={{ padding: "0 0 10px" }}>Intake photos ({order.intakePhotos.length})</div>
          <div className="row wrap gap8">
            {order.intakePhotos.map((key, i) => (
              <a key={key} href={`/api/receipt?key=${encodeURIComponent(key)}`} target="_blank" rel="noreferrer">
                <img
                  src={`/api/receipt?key=${encodeURIComponent(key)}`}
                  alt={`Intake ${i + 1}`}
                  style={{ width: 76, height: 76, objectFit: "cover", borderRadius: 10, border: "1px solid var(--line)" }}
                />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Status timeline */}
      {order.timeline.length > 0 && (
        <div className="card pad mt12">
          <div className="sec-title" style={{ padding: "0 0 10px" }}>Timeline</div>
          <div className="tl">
            {order.timeline.map((t, i) => (
              <div key={i} className="tl-item done">
                <div className="tl-dot"><Svg name="check" size={11} sw={3} /></div>
                <div>
                  <div className="h-sm" style={{ textTransform: "capitalize" }}>{STATUS_LABEL[t.status] || t.status}</div>
                  <div className="muted" style={{ fontSize: "12px" }}>{dateStr(t.at)} · {timeAgo(t.at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Per-garment QR tags */}
      {order.tags.length > 0 && (
        <div className="card pad mt12">
          <div className="between">
            <div className="sec-title" style={{ padding: 0 }}>Garment tags</div>
            <span className="pill gray">{order.tags.filter((t) => t.scanned).length}/{order.tags.length} scanned</span>
          </div>
          <div className="row wrap gap8 mt12">
            {order.tags.map((t) => (
              <button
                key={t.code}
                onClick={() => handleScanTag(t.code)}
                className="card"
                style={{ padding: "8px 10px", textAlign: "center", borderColor: t.scanned ? "var(--teal)" : "var(--line)", background: t.scanned ? "var(--teal-tint)" : "var(--card)" }}
              >
                <Qr text={t.code} size={54} />
                <div className="mono" style={{ fontSize: "10.5px", marginTop: 4, color: t.scanned ? "var(--teal-dark)" : "var(--muted)" }}>{t.code}</div>
                <div className="muted" style={{ fontSize: "10px" }}>{t.label}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Payment status & actions */}
      {isDraft && (
        <button className="btn mt16" onClick={() => setShowAcceptSheet(true)}>
          <Svg name="check" size={18} /> Verify & accept order
        </button>
      )}

      {!isDraft && order.status !== "collected" && (
        <>
          {order.status !== "ready" && (
            <button className="btn mt16" onClick={handleAdvance}>
              {order.status === "received" ? "Start processing" : order.status === "processing" ? "Mark ready for collection" : "Verify & mark collected"}
            </button>
          )}

          {order.status === "ready" && (
            <button className="btn mt16" onClick={() => setShowCollectSheet(true)}>
              <Svg name="check" size={18} /> Collect order
            </button>
          )}

          {/* Gated on MONEY OWING, not on how the order was billed.
              This used to read `!order.usedCycle`, which hid the button — and
              with it the only route to the UPI QR — on every cycle order. That
              was invisible while cycle orders came to ₹0, but a bag over the
              7 kg allowance (or an urgent cycle premium) owes real money, and
              there was no way to collect it in the app. */}
          {!order.paid && Number(order.total) > 0 && (
            <button className="btn ghost mt10" onClick={() => setShowPaymentSheet(true)}>
              <Svg name="card" size={17} />{" "}
              {order.usedCycle ? `Collect ${fmt(Number(order.total))} — over the ${CYCLE_KG_LIMIT} kg cycle` : "Record payment"}
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
        </>
      )}

      {/* Action buttons */}
      <div className="divider mt16" />
      <div className="row gap8" style={{ flexWrap: "wrap" }}>
        <button className="btn xs sec" onClick={() => setShowPrintSheet(true)}>
          <Svg name="printer" size={15} /> Print tag
        </button>
        <button className="btn xs sec" onClick={() => setShowCompensationSheet(true)}>
          <Svg name="gift" size={15} /> Compensation
        </button>
        {order.invoice && (
          <a href={`/api/export/invoice/${order.id}`} className="btn xs sec">
            <Svg name="card" size={15} /> GST bill
          </a>
        )}
        <a href={`https://wa.me/91${order.student.phone}?text=${encodeURIComponent(`Your ${order.service} order #${order.id.slice(-4)} is ready for collection`)}`} target="_blank" className="btn xs sec" style={{ color: "#0f8a4d", borderColor: "#bfe6cf" }}>
          <Svg name="chat" size={15} /> WhatsApp
        </a>
        {order.paid && !order.refunded && (
          <button className="btn xs sec danger" onClick={() => setShowRefundSheet(true)}>
            <Svg name="back" size={15} /> Refund
          </button>
        )}
        {["processing", "ready", "collected"].includes(order.status) && (
          <button className="btn xs sec" onClick={handleRedo}>
            <Svg name="layers" size={15} /> Free re-do
          </button>
        )}
        {!["collected", "cancelled"].includes(order.status) && (
          <button className="btn xs sec danger" onClick={handleCancel}>
            <Svg name="x" size={15} /> Cancel
          </button>
        )}
      </div>

      {/* SHEETS */}

      {/* Recount before marking ready */}
      <Sheet open={showReady} onClose={() => setShowReady(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>Mark ready — confirm the count</h2>
          <div className="muted" style={{ fontSize: "12.5px", marginBottom: "16px" }}>
            {intakeCount} pieces were logged at drop-off. Count the folded pile before it goes on
            the shelf — finding a missing item now is an apology, finding it at the counter is a dispute.
          </div>
          <div className="field">
            <label>Pieces counted</label>
            <input
              className="input"
              type="number"
              value={countedPieces}
              onChange={(e) => setCountedPieces(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
            />
          </div>
          {countedPieces < intakeCount && (
            <div className="card pad" style={{ background: "var(--amber-soft)", borderColor: "#f2e2c4", marginBottom: "12px" }}>
              <span style={{ fontSize: "12.5px", color: "var(--amber)" }}>
                Short by {intakeCount - countedPieces}. The student is told now, and the Owner is notified.
              </span>
            </div>
          )}
          {countedPieces > intakeCount && (
            <div className="muted" style={{ fontSize: "12.5px", marginBottom: "12px" }}>
              More than logged at intake — the count will be corrected to {countedPieces}.
            </div>
          )}
          <button className="btn" onClick={confirmReady} disabled={readyBusy}>
            <Svg name="check" size={18} /> {readyBusy ? "Saving…" : "Confirm & mark ready"}
          </button>
        </div>
      </Sheet>

      {/* Damage report sheet */}
      <Sheet open={showDamage} onClose={() => setShowDamage(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "8px" }}>Report damage</h2>
          <div className="muted" style={{ fontSize: "12.5px", marginBottom: "16px" }}>
            This opens a complaint the student can see and reply to. It is the record if they
            dispute it later, so photograph the damage clearly from a few angles.
          </div>

          <div className="field">
            <label>What did you find? <span style={{ color: "var(--red)" }}>*</span></label>
            <textarea
              className="input"
              rows={3}
              placeholder="e.g. Tear on the left sleeve of the blue shirt, already present at drop-off"
              value={damageComment}
              onChange={(e) => setDamageComment(e.target.value)}
            />
          </div>

          <div className="field">
            <label>
              Photos <span style={{ color: "var(--red)" }}>*</span>{" "}
              <span className="muted">({damagePhotos.length}/{MIN_DAMAGE_PHOTOS} minimum)</span>
            </label>
            {damagePhotos.length > 0 && (
              <div className="row wrap gap8" style={{ marginBottom: "10px" }}>
                {damagePhotos.map((key, i) => (
                  <div key={key} style={{ position: "relative" }}>
                    <img
                      src={`/api/receipt?key=${encodeURIComponent(key)}`}
                      alt={`Damage ${i + 1}`}
                      style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 10, border: "1px solid var(--line)" }}
                    />
                    <button
                      onClick={() => setDamagePhotos((p) => p.filter((k) => k !== key))}
                      style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: "var(--red)", color: "#fff", border: "none", fontSize: 12, lineHeight: 1, display: "grid", placeItems: "center" }}
                      aria-label="Remove photo"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <label className="btn sec" style={{ cursor: "pointer" }}>
              <Svg name="camera" size={16} />{" "}
              {uploadingPhoto ? "Uploading…" : damagePhotos.length ? "Add another photo" : "Take a photo"}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                disabled={uploadingPhoto}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleDamagePhoto(f);
                  e.target.value = "";
                }}
              />
            </label>
          </div>

          <button
            className="btn mt16"
            disabled={damageBusy || uploadingPhoto || damagePhotos.length < MIN_DAMAGE_PHOTOS || damageComment.trim().length < 5}
            onClick={submitDamage}
          >
            <Svg name="check" size={18} />{" "}
            {damageBusy
              ? "Sending…"
              : damagePhotos.length < MIN_DAMAGE_PHOTOS
                ? `Add ${MIN_DAMAGE_PHOTOS - damagePhotos.length} more photo${MIN_DAMAGE_PHOTOS - damagePhotos.length === 1 ? "" : "s"}`
                : "Send to student"}
          </button>
        </div>
      </Sheet>

      {/* Accept sheet */}
      <Sheet open={showAcceptSheet} onClose={() => setShowAcceptSheet(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "16px" }}>Accept order</h2>
          {isOffWashDay(order.student.washDay) && (
            <div className="card pad mt12" style={{ background: "var(--amber-soft)", borderColor: "#f2e2c4", marginBottom: "16px" }}>
              <div className="row gap8">
                <span style={{ color: "var(--amber)" }}><Svg name="alert" size={18} /></span>
                <span style={{ color: "var(--amber)", fontSize: "12.5px" }}>
                  Heads up — {order.student.name}&apos;s usual wash day is {WEEKDAY_NAMES[order.student.washDay as number]}. Fine to accept anyway, just flagging it.
                </span>
              </div>
            </div>
          )}
          <div className="field">
            <label>Weight (kg)</label>
            {/* type="text" + inputMode="decimal": a number input shows spinner
                arrows nobody weighs with, and its value-coercion made "5." and
                a leading zero fight the typist. The raw string is kept in
                state so the field shows exactly what was typed; it is parsed
                once, on Accept. */}
            <input
              className="input"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="e.g. 4.6"
              value={weightText}
              onChange={(e) => {
                const t = e.target.value;
                if (t !== "" && !/^\d{0,3}(\.\d{0,2})?$/.test(t)) return; // ignore stray characters
                setWeightText(t);
                setAcceptInput((a) => ({ ...a, weightKg: Number(t) || 0 }));
              }}
            />
            {cycleBased && (
              <div className="field" style={{ marginTop: "12px" }}>
                <label>Cycles</label>
                <div className="row gap8" style={{ alignItems: "center" }}>
                  <div className="qty">
                    <button onClick={() => setAcceptInput((a) => ({ ...a, cycles: Math.max(1, a.cycles - 1) }))}>−</button>
                    <span className="mono">{acceptInput.cycles}</span>
                    <button onClick={() => setAcceptInput((a) => ({ ...a, cycles: Math.min(10, a.cycles + 1) }))}>+</button>
                  </div>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {acceptInput.useCycle
                      ? `burns ${acceptInput.cycles} from the plan · ${allowanceKg} kg allowance`
                      : `${fmt(CYCLE_RATES[order.service] * acceptInput.cycles)} · ${allowanceKg} kg allowance`}
                  </span>
                </div>
              </div>
            )}
            {cycleBased && (
              <div className="muted" style={{ fontSize: "12px", marginTop: "7px" }}>
                {overKg > 0 ? (
                  acceptInput.waiveExcess ? (
                    <span style={{ fontWeight: 600 }}>
                      {Math.ceil(overKg * 2) / 2} kg over — charge waived, nothing to collect.
                    </span>
                  ) : (
                    <span style={{ color: "var(--amber)", fontWeight: 600 }}>
                      {/* Billed per started HALF kg — quote the same number that bills. */}
                      {Math.ceil(overKg * 2) / 2} kg over the {allowanceKg} kg allowance — collect {fmt(excessNow)}
                    </span>
                  )
                ) : (
                  <>Within the {allowanceKg} kg allowance — nothing extra.</>
                )}
              </div>
            )}
            {/* The waiver appears only when there is a charge to waive; a
                switch that mostly does nothing teaches staff to ignore it. */}
            {cycleBased && overKg > 0 && (
              <div className="chip-toggle" style={{ marginTop: "10px" }}>
                <div>
                  <div className="h-sm">Waive excess charge</div>
                  <div className="muted" style={{ fontSize: "12px" }}>Recorded in the audit log with your name</div>
                </div>
                <Switch on={acceptInput.waiveExcess} onToggle={() => setAcceptInput({ ...acceptInput, waiveExcess: !acceptInput.waiveExcess })} />
              </div>
            )}
          </div>
          {order.student.subscription?.active && (
            <div className="chip-toggle" style={{ marginBottom: "16px" }}>
              <div>
                <div className="h-sm">Use subscription cycle</div>
                <div className="muted" style={{ fontSize: "12px" }}>{order.student.subscription.cyclesTotal - order.student.subscription.cyclesUsed} left</div>
              </div>
              <Switch on={acceptInput.useCycle} onToggle={() => setAcceptInput({ ...acceptInput, useCycle: !acceptInput.useCycle })} />
            </div>
          )}
          {acceptInput.useCycle && order.express && (
            <div className="card pad mt12" style={{ background: "var(--amber-soft)", borderColor: "#f2e2c4", marginBottom: "16px" }}>
              <span style={{ fontSize: "12.5px", color: "var(--amber)" }}>
                This order is marked urgent. The cycle covers the wash — collect a 40% premium on its per-cycle plan value in cash before handing it over.
              </span>
            </div>
          )}
          {!acceptInput.useCycle && !cycleBased && (
            <div className="chip-toggle" style={{ marginBottom: "16px" }}>
              <div>
                <div className="h-sm">Bill without GST</div>
                <div className="muted" style={{ fontSize: "12px" }}>Charge {fmt(Number(order.subtotal) + Number(order.surcharge))} — recorded, no GST invoice</div>
              </div>
              <Switch on={acceptInput.noGst} onToggle={() => setAcceptInput({ ...acceptInput, noGst: !acceptInput.noGst })} />
            </div>
          )}
          <div className="field">
            <label>Damage / condition photos <span className="muted">(optional)</span></label>
            <div className="muted" style={{ fontSize: "12px", marginBottom: "8px" }}>
              Snap any existing stains or damage before washing — protects both sides in a dispute.
            </div>
            {intakePhotos.length > 0 && (
              <div className="row wrap gap8" style={{ marginBottom: "10px" }}>
                {intakePhotos.map((key, i) => (
                  <div key={key} style={{ position: "relative" }}>
                    <img
                      src={`/api/receipt?key=${encodeURIComponent(key)}`}
                      alt={`Intake ${i + 1}`}
                      style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 10, border: "1px solid var(--line)" }}
                    />
                    <button
                      onClick={() => setIntakePhotos((p) => p.filter((k) => k !== key))}
                      style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: "var(--red)", color: "#fff", border: "none", fontSize: 12, lineHeight: 1, display: "grid", placeItems: "center" }}
                    >×</button>
                  </div>
                ))}
              </div>
            )}
            <label className="btn sec sm" style={{ width: "auto", cursor: "pointer" }}>
              <Svg name="camera" size={16} /> {uploadingPhoto ? "Uploading…" : "Add photo"}
              <input
                type="file"
                accept="image/*"
                capture="environment"
                style={{ display: "none" }}
                disabled={uploadingPhoto || intakePhotos.length >= 6}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleIntakePhoto(f); e.target.value = ""; }}
              />
            </label>
          </div>
          <button className="btn mt16" onClick={handleAccept}>
            <Svg name="check" size={18} /> Accept
          </button>
        </div>
      </Sheet>

      {/* Collect sheet */}
      <Sheet open={showCollectSheet} onClose={() => setShowCollectSheet(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "16px" }}>Collect order</h2>
          <p className="muted" style={{ fontSize: "13px", marginBottom: "12px" }}>Enter the 4-digit OTP the student shows, or scan the QR tag</p>
          <div className="field">
            <label>Code or tag</label>
            <input
              className="input"
              type="text"
              placeholder="e.g. 1234"
              autoFocus
              value={collectCode}
              onChange={(e) => setCollectCode(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter" && collectCode.trim()) handleCollect(); }}
            />
          </div>
          <button className="btn mt16" onClick={handleCollect}>
            <Svg name="check" size={18} /> Verify & collect
          </button>
          {expectedPickupCode && (
            <div className="muted center mt12" style={{ fontSize: "12px" }}>
              Expected code: <b className="mono">{expectedPickupCode}</b>
            </div>
          )}
        </div>
      </Sheet>

      {/* Payment sheet */}
      <Sheet open={showPaymentSheet} onClose={() => setShowPaymentSheet(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "16px" }}>Record payment</h2>

          {!order.noGst && (
            <div className="chip-toggle" style={{ marginBottom: "12px" }}>
              <div>
                <div className="h-sm">GST bill for cash</div>
                <div className="muted" style={{ fontSize: "12px" }}>Force invoice on cash payment</div>
              </div>
              <Switch on={staffInvoice} onToggle={() => setStaffInvoice(!staffInvoice)} />
            </div>
          )}
          {order.noGst && (
            <div className="pill" style={{ marginBottom: "12px" }}>No-GST order — payment is recorded without an invoice</div>
          )}

          <div className="chip-toggle" style={{ marginBottom: "16px" }}>
            <div>
              <div className="h-sm">Apply credits</div>
              <div className="muted" style={{ fontSize: "12px" }}>{fmt(creditCover)}</div>
            </div>
            <Switch on={applyCredits} onToggle={() => setApplyCredits(!applyCredits)} />
          </div>

          {applyCredits && (
            <div className="card pad" style={{ background: "var(--teal-tint)", marginBottom: "16px" }}>
              <div className="kv">
                <span className="k">Credit applied</span>
                <span className="mono">{fmt(creditCover)}</span>
              </div>
              <div className="kv">
                <span className="k">Remaining to collect</span>
                <span className="mono">{fmt(remaining)}</span>
              </div>
            </div>
          )}

          <Seg<"cash" | "upi">
            options={[
              ["cash", "Cash"],
              ["upi", "UPI"],
            ]}
            value={paymentMethod}
            onChange={setPaymentMethod}
          />

          {paymentMethod === "cash" && (
            <button className="btn mt16" onClick={handlePayCash}>
              <Svg name="wallet" size={18} /> Record cash payment
            </button>
          )}

          {paymentMethod === "upi" && (
            <button className="btn mt16" onClick={() => setShowUpiSheet(true)}>
              <Svg name="wallet" size={18} /> Show UPI QR
            </button>
          )}
        </div>
      </Sheet>

      {/* UPI QR sheet */}
      <Sheet open={showUpiSheet} onClose={() => setShowUpiSheet(false)}>
        <div className="pad" style={{ textAlign: "center" }}>
          <h2 style={{ marginBottom: "16px" }}>UPI payment</h2>
          <div style={{ background: "#fff", padding: "16px", borderRadius: "12px", marginBottom: "16px", display: "inline-block" }}>
            <Qr text={upiLink(upi.upiId, upi.payeeName, remaining, `Order ${order.id.slice(-4)}`)} size={200} />
          </div>
          <div className="muted" style={{ fontSize: "12px", marginBottom: "16px" }}>
            Amount: {fmt(remaining)}
          </div>
          <button className="btn" onClick={handlePayUpi}>
            <Svg name="check" size={18} /> Mark payment received
          </button>
        </div>
      </Sheet>

      {/* Refund sheet */}
      <Sheet open={showRefundSheet} onClose={() => setShowRefundSheet(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "16px" }}>Refund order</h2>
          <div className="field">
            <label>Amount (₹)</label>
            <input
              className="input"
              type="number"
              value={refundInput.amount}
              onChange={(e) => setRefundInput({ ...refundInput, amount: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Via</label>
            <Seg<"upi" | "cash" | "credit">
              options={[
                ["upi", "UPI"],
                ["cash", "Cash"],
                ["credit", "Store credit"],
              ]}
              value={refundInput.via}
              onChange={(v) => setRefundInput({ ...refundInput, via: v })}
            />
          </div>
          <div className="field">
            <label>Reason</label>
            <input
              className="input"
              type="text"
              placeholder="e.g. Customer request"
              value={refundInput.reason}
              onChange={(e) => setRefundInput({ ...refundInput, reason: e.target.value })}
            />
          </div>
          {order.usedCycle && (
            <div className="chip-toggle" style={{ marginBottom: "12px" }}>
              <div>
                <div className="h-sm">Also return the plan cycle</div>
                <div className="muted" style={{ fontSize: "12px" }}>
                  Only if the wash never happened. Refunding just an urgent premium still used a cycle.
                </div>
              </div>
              <Switch on={refundInput.restoreCycle} onToggle={() => setRefundInput({ ...refundInput, restoreCycle: !refundInput.restoreCycle })} />
            </div>
          )}
          <button className="btn mt16" onClick={handleRefund}>
            <Svg name="back" size={18} /> Process refund
          </button>
        </div>
      </Sheet>

      {/* Compensation sheet */}
      <Sheet open={showCompensationSheet} onClose={() => setShowCompensationSheet(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "16px" }}>Issue compensation</h2>
          <div className="field">
            <label>Kind</label>
            <Seg<string>
              options={[
                ["damage", "Damage"],
                ["stain", "Stain"],
                ["missing", "Missing"],
                ["goodwill", "Goodwill"],
                ["manual", "Manual"],
              ]}
              value={compInput.kind}
              onChange={(k) => setCompInput({ ...compInput, kind: k })}
            />
          </div>
          <div className="field">
            <label>Amount (₹)</label>
            <input
              className="input"
              type="number"
              value={compInput.amount}
              onChange={(e) => setCompInput({ ...compInput, amount: Number(e.target.value) })}
            />
          </div>
          <div className="field">
            <label>Method</label>
            <Seg<"credit" | "cash">
              options={staffRole >= 2 ? [["credit", "Store credit"], ["cash", "Cash"]] : [["credit", "Store credit"]]}
              value={compInput.method}
              onChange={(m) => setCompInput({ ...compInput, method: m })}
            />
          </div>
          <div className="field">
            <label>Comment</label>
            <input
              className="input"
              type="text"
              placeholder="e.g. Button fell off"
              value={compInput.comment}
              onChange={(e) => setCompInput({ ...compInput, comment: e.target.value })}
            />
          </div>
          <button className="btn mt16" onClick={handleCompensation}>
            <Svg name="gift" size={18} /> Issue compensation
          </button>
        </div>
      </Sheet>

      {/* Print sheet */}
      <Sheet open={showPrintSheet} onClose={() => setShowPrintSheet(false)}>
        <div className="pad" style={{ textAlign: "center" }}>
          <h2 style={{ marginBottom: "16px" }}>Print tag</h2>
          <div style={{ background: "#fff", padding: "24px", borderRadius: "12px", marginBottom: "16px" }}>
            <div style={{ fontSize: "24px", fontWeight: "700", marginBottom: "8px", fontFamily: "monospace" }}>
              {order.id.slice(-4)}
            </div>
            <div className="muted" style={{ fontSize: "12px" }}>
              {order.student.name}
            </div>
            <div className="muted" style={{ fontSize: "12px", marginTop: "8px" }}>
              {serviceRates.label}
            </div>
          </div>
          <button
            className="btn"
            onClick={() => {
              window.print();
              setShowPrintSheet(false);
            }}
          >
            <Svg name="printer" size={18} /> Print
          </button>
        </div>
      </Sheet>
    </div>
  );
}
