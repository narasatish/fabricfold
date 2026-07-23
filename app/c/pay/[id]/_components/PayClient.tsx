"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast, Switch, Sheet } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { fmt, upiLink } from "@/lib/format";
import { Qr } from "@/components/qr";
import { payOrder } from "@/lib/actions/orders";
import { createGatewayOrder, confirmGatewayPayment } from "@/lib/actions/payments";
import { simulateGatewayPayment } from "@/lib/actions/testing";

declare global {
  interface Window { Razorpay?: new (opts: Record<string, unknown>) => { open: () => void }; }
}

function loadRazorpay(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

export default function PayClient({
  orderId, orderTotal, orderService, orderPieces, studentCredits,
  paymentUpiId, paymentPayeeName, gatewayEnabled, testPay,
}: {
  orderId: string;
  orderTotal: number;
  orderService: string;
  orderPieces: Array<{ qty: number }>;
  studentCredits: number;
  paymentUpiId: string;
  paymentPayeeName: string;
  gatewayEnabled: boolean;
  testPay?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [applyCredits, setApplyCredits] = useState(false);
  const [showUpi, setShowUpi] = useState(false);
  const [loading, setLoading] = useState(false);

  const hasCredit = studentCredits > 0;
  const applyMax = Math.min(studentCredits, orderTotal);
  const applied = hasCredit && applyCredits ? applyMax : 0;
  const remaining = orderTotal - applied;

  /* Credits cover the whole bill — settle immediately through the real money path. */
  const payWithCredits = async () => {
    setLoading(true);
    const r = await payOrder(orderId, "upi", true);
    setLoading(false);
    if (!r.ok) return toast(r.error || "Payment failed", true);
    toast("Paid with credits");
    router.push(`/c/orders/${orderId}`);
  };

  /* Online payment via Razorpay checkout (UPI / card / netbanking). */
  const payOnline = async () => {
    setLoading(true);
    const r = await createGatewayOrder(orderId, applied > 0);
    if (!r.ok) { setLoading(false); return toast(r.error || "Could not start payment", true); }
    const ok = await loadRazorpay();
    if (!ok || !window.Razorpay) { setLoading(false); return toast("Could not load the payment window", true); }
    const rzp = new window.Razorpay({
      key: r.keyId,
      order_id: r.rzpOrderId,
      amount: r.amount,
      currency: "INR",
      name: "FabricFold",
      description: `Order #${orderId.slice(-4)} · ${orderService}`,
      prefill: { name: r.name, contact: r.phone },
      theme: { color: "#0e9271" },
      handler: async (resp: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) => {
        const v = await confirmGatewayPayment(orderId, applied > 0, {
          orderId: resp.razorpay_order_id,
          paymentId: resp.razorpay_payment_id,
          signature: resp.razorpay_signature,
        });
        setLoading(false);
        if (!v.ok) return toast(v.error || "Payment verification failed", true);
        toast("Payment successful");
        router.push(`/c/orders/${orderId}`);
      },
      modal: { ondismiss: () => setLoading(false) },
    });
    rzp.open();
  };

  const totalPieces = orderPieces.reduce((s, i) => s + i.qty, 0);

  return (
    <>
      <div className="card pad center">
        <div className="label">Amount due</div>
        <div className="big-num mt4">{fmt(orderTotal)}</div>
        <div className="muted mt4" style={{ fontSize: "12.5px" }}>{orderService} · {totalPieces} pcs</div>
      </div>

      {/* Credit toggle */}
      {hasCredit && (
        <>
          <div className="chip-toggle mt16">
            <div className="row gap8">
              <span style={{ color: "var(--teal)" }}><Svg name="gift" size={20} /></span>
              <div>
                <div className="h-sm">Apply credits</div>
                <div className="muted" style={{ fontSize: "12px" }}>Balance {fmt(studentCredits)} · covers {fmt(applyMax)} of this bill</div>
              </div>
            </div>
            <Switch on={applyCredits} onToggle={() => setApplyCredits(!applyCredits)} />
          </div>

          {applied > 0 && (
            <div className="card pad mt10">
              <div className="kv"><span className="k">Bill total</span><span className="mono">{fmt(orderTotal)}</span></div>
              <div className="kv"><span className="k" style={{ color: "var(--teal-dark)" }}>Credits applied</span><span className="mono" style={{ color: "var(--teal-dark)" }}>−{fmt(applied)}</span></div>
              <div className="kv total"><span>Remaining</span><span className="mono">{fmt(remaining)}</span></div>
            </div>
          )}
        </>
      )}

      {/* Payment options */}
      <div className="sec-title mt20">
        {remaining <= 0 ? "Confirm payment" : applied > 0 ? `Pay remaining ${fmt(remaining)}` : "Payment method"}
      </div>

      {remaining <= 0 ? (
        <button className="btn" onClick={payWithCredits} disabled={loading}>
          <Svg name="gift" size={18} /> {loading ? "Paying…" : `Pay ${fmt(applied)} with credits`}
        </button>
      ) : (
        <>
          {gatewayEnabled && (
            <button className="card-btn" onClick={payOnline} disabled={loading}>
              <div className="icon-tile"><Svg name="card" size={22} /></div>
              <div style={{ flex: 1 }}>
                <div className="h-sm">{loading ? "Opening…" : "Pay online"}</div>
                <div className="muted" style={{ fontSize: "12.5px" }}>UPI · card · netbanking — instant confirmation</div>
              </div>
              <Svg name="chevR" size={18} />
            </button>
          )}
          {!gatewayEnabled && testPay && (
            <button className="card-btn" style={{ borderColor: "var(--amber)" }} disabled={loading}
              onClick={async () => {
                setLoading(true);
                const r = await simulateGatewayPayment(orderId, applied > 0);
                setLoading(false);
                if (!r.ok) return toast(r.error || "Failed", true);
                toast("Test payment successful");
                router.push(`/c/orders/${orderId}`);
              }}>
              <div className="icon-tile"><Svg name="card" size={22} /></div>
              <div style={{ flex: 1 }}>
                <div className="h-sm" style={{ color: "var(--amber)" }}>{loading ? "Processing…" : "Simulate online payment (TEST)"}</div>
                <div className="muted" style={{ fontSize: "12.5px" }}>Runs the real settle + invoice path — no card charged</div>
              </div>
              <Svg name="chevR" size={18} />
            </button>
          )}
          <button className={`card-btn ${gatewayEnabled ? "mt10" : ""}`} onClick={() => setShowUpi(true)}>
            <div className="icon-tile"><Svg name="qr" size={22} /></div>
            <div style={{ flex: 1 }}>
              <div className="h-sm">UPI at the counter</div>
              <div className="muted" style={{ fontSize: "12.5px" }}>Scan our QR — staff confirm on the spot</div>
            </div>
            <Svg name="chevR" size={18} />
          </button>
          <div className="card pad mt10">
            <div className="row gap8">
              <span style={{ color: "var(--teal)" }}><Svg name="wallet" size={20} /></span>
              <div className="muted" style={{ fontSize: "13px" }}>
                Prefer cash? Just pay at the counter — staff will record it against this order.
              </div>
            </div>
          </div>
        </>
      )}

      {/* Counter-UPI sheet: QR to pay; staff confirm receipt (no self-confirmation). */}
      <Sheet open={showUpi} onClose={() => setShowUpi(false)}>
        <div className="center">
          <div className="h-md">Pay by UPI</div>
          <div className="muted mt4" style={{ fontSize: "13px" }}>{fmt(remaining || orderTotal)} to {paymentPayeeName}</div>

          {paymentUpiId ? (
            <>
              <div style={{ width: "212px", height: "212px", margin: "16px auto", padding: "11px", borderRadius: "16px", border: "1px solid var(--line-2)", background: "#fff" }}>
                <Qr text={upiLink(paymentUpiId, paymentPayeeName, remaining || orderTotal, "Order " + orderId.slice(-6))} size={180} dark="#12211c" light="#fff" />
              </div>
              <div className="pill gray" style={{ userSelect: "all" }}>{paymentUpiId}</div>
              <a href={upiLink(paymentUpiId, paymentPayeeName, remaining || orderTotal, "Order " + orderId.slice(-6))} className="btn mt16">
                <Svg name="phone" size={18} /> Open UPI app to pay
              </a>
              <div className="muted mt8" style={{ fontSize: "11.5px" }}>
                After paying, show the success screen at the counter — staff confirm it against your order.
              </div>
            </>
          ) : (
            <div className="muted mt12" style={{ fontSize: "13px" }}>UPI details aren&apos;t set up yet — please pay at the counter.</div>
          )}

          <button className="btn sec mt12" onClick={() => setShowUpi(false)}>Close</button>
        </div>
      </Sheet>
    </>
  );
}
