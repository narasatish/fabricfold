"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast, Sheet, Seg } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { fmt } from "@/lib/format";
import { requestSubscription } from "@/lib/actions/subscription";

export default function WalletClient({ planTotal, cycles, kg }: { planTotal: number; cycles: number; kg: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState<"upi" | "cash">("upi");
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  const request = async () => {
    setLoading(true);
    const r = await requestSubscription(method);
    setLoading(false);
    if (!r.ok) return toast(r.error || "Couldn't send request", true);
    if (r.code) {
      setCode(r.code); // cash: student shows this code to staff to activate
    } else {
      toast("Request sent — pay by UPI at the counter");
      setOpen(false);
      router.refresh();
    }
  };

  const close = () => { setOpen(false); setCode(null); router.refresh(); };

  return (
    <>
      <button className="btn mt16" onClick={() => { setCode(null); setOpen(true); }}>
        <Svg name="layers" size={17} /> Get the plan
      </button>

      <Sheet open={open} onClose={close}>
        <div className="pad">
          {code ? (
            <div className="center">
              <h2 style={{ marginBottom: "8px" }}>Show this at the counter</h2>
              <p className="muted" style={{ fontSize: "13px", marginBottom: "16px" }}>
                Pay {fmt(planTotal)} cash and show this code — staff will activate your plan.
              </p>
              <div className="otp-box">{code}</div>
              <button className="btn mt20" onClick={close}>Done</button>
            </div>
          ) : (
            <>
              <h2 style={{ marginBottom: "6px" }}>Get the annual plan</h2>
              <p className="muted" style={{ fontSize: "13px", marginBottom: "14px" }}>
                {cycles} cycles a year · up to {kg}kg per drop-off. Your plan activates once staff confirm payment.
              </p>
              <div className="card pad" style={{ background: "var(--teal-tint)", marginBottom: "16px" }}>
                <div className="kv total"><span>To pay</span><span className="mono">{fmt(planTotal)}</span></div>
              </div>
              <div className="field">
                <label>Pay by</label>
                <Seg<"upi" | "cash"> options={[["upi", "UPI"], ["cash", "Cash"]]} value={method} onChange={setMethod} />
              </div>
              <button className="btn mt16" onClick={request} disabled={loading}>
                <Svg name="check" size={18} /> {loading ? "Sending…" : "Request plan"}
              </button>
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}
