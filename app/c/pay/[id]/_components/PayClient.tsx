"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/chrome";
import { Switch } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { fmt, upiLink } from "@/lib/format";
import { Sheet } from "@/components/chrome";
import { Qr } from "@/components/qr";

export default function PayClient({
  orderId,
  orderTotal,
  orderService,
  orderPieces,
  studentCredits,
  paymentUpiId,
  paymentPayeeName,
}: {
  orderId: string;
  orderTotal: number;
  orderService: string;
  orderPieces: Array<any>;
  studentCredits: number;
  paymentUpiId: string;
  paymentPayeeName: string;
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

  const handlePaymentSuccess = async (method: string) => {
    setLoading(true);
    // TODO: call payOrder action
    setLoading(false);
    toast("Payment successful");
    router.push(`/c/orders/${orderId}`);
  };

  const totalPieces = (orderPieces as Array<{ qty: number }>).reduce((s, i) => s + i.qty, 0);

  return (
    <>
      <div className="card pad center">
        <div className="label">Amount due</div>
        <div className="big-num mt4">{fmt(orderTotal)}</div>
        <div className="muted mt4" style={{ fontSize: "12.5px" }}>
          {orderService} · {totalPieces} pcs
        </div>
      </div>

      {/* Credit toggle */}
      {hasCredit && (
        <>
          <div className="chip-toggle mt16">
            <div className="row gap8">
              <span style={{ color: "var(--teal)" }}>
                <Svg name="gift" size={20} />
              </span>
              <div>
                <div className="h-sm">Apply credits</div>
                <div className="muted" style={{ fontSize: "12px" }}>
                  Balance {fmt(studentCredits)} · covers {fmt(applyMax)} of this bill
                </div>
              </div>
            </div>
            <Switch on={applyCredits} onToggle={() => setApplyCredits(!applyCredits)} />
          </div>

          {applied > 0 && (
            <div className="card pad mt10">
              <div className="kv">
                <span className="k">Bill total</span>
                <span className="mono">{fmt(orderTotal)}</span>
              </div>
              <div className="kv">
                <span className="k" style={{ color: "var(--teal-dark)" }}>
                  Credits applied
                </span>
                <span className="mono" style={{ color: "var(--teal-dark)" }}>
                  −{fmt(applied)}
                </span>
              </div>
              <div className="kv total">
                <span>Remaining</span>
                <span className="mono">{fmt(remaining)}</span>
              </div>
            </div>
          )}
        </>
      )}

      {/* Payment options */}
      <div className="sec-title mt20">
        {remaining <= 0 ? "Confirm payment" : applied > 0 ? `Pay remaining ${fmt(remaining)}` : "Payment method"}
      </div>

      {remaining <= 0 ? (
        <button className="btn" onClick={() => handlePaymentSuccess("credit")} disabled={loading}>
          <Svg name="gift" size={18} /> Pay {fmt(applied)} with credits
        </button>
      ) : (
        <>
          <button className="card-btn" onClick={() => setShowUpi(true)}>
            <div className="icon-tile">
              <Svg name="qr" size={22} />
            </div>
            <div style={{ flex: 1 }}>
              <div className="h-sm">UPI</div>
              <div className="muted" style={{ fontSize: "12.5px" }}>
                Scan / pay in-app
              </div>
            </div>
            <Svg name="chevR" size={18} />
          </button>
          <button className="card-btn mt10" onClick={() => handlePaymentSuccess("cash")}>
            <div className="icon-tile">
              <Svg name="wallet" size={22} />
            </div>
            <div style={{ flex: 1 }}>
              <div className="h-sm">Cash</div>
              <div className="muted" style={{ fontSize: "12.5px" }}>
                Pay at counter
              </div>
            </div>
            <Svg name="chevR" size={18} />
          </button>
        </>
      )}

      {/* UPI Sheet */}
      <Sheet open={showUpi} onClose={() => setShowUpi(false)}>
        <div className="center">
          <div className="h-md">Pay by UPI</div>
          <div className="muted mt4" style={{ fontSize: "13px" }}>
            {fmt(remaining || orderTotal)} to {paymentPayeeName}
          </div>

          {paymentUpiId && (
            <>
              <div style={{ width: "212px", height: "212px", margin: "16px auto", padding: "11px", borderRadius: "16px", border: "1px solid var(--line-2)", background: "#fff" }}>
                <Qr text={upiLink(paymentUpiId, paymentPayeeName, remaining || orderTotal, "Order " + orderId.slice(-6))} size={180} dark="#12211c" light="#fff" />
              </div>
              <div className="pill gray" style={{ userSelect: "all" }}>
                {paymentUpiId}
              </div>
              <a
                href={upiLink(paymentUpiId, paymentPayeeName, remaining || orderTotal, "Order " + orderId.slice(-6))}
                className="btn mt16"
              >
                <Svg name="phone" size={18} /> Open UPI app to pay
              </a>
              <div className="muted mt8" style={{ fontSize: "11.5px" }}>
                Scan the QR from any UPI app (GPay / PhonePe / Paytm), or tap to pay on this phone.
              </div>
            </>
          )}

          <button
            className="btn mt12"
            onClick={() => {
              setShowUpi(false);
              handlePaymentSuccess("upi");
            }}
          >
            <Svg name="card" size={18} /> I've paid — confirm manually
          </button>
          <button className="btn sec mt10" onClick={() => setShowUpi(false)}>
            Cancel
          </button>
        </div>
      </Sheet>
    </>
  );
}
