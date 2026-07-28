"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast, Sheet, Seg } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { fmt } from "@/lib/format";
import { requestSubscription, cancelSubscriptionRequest } from "@/lib/actions/subscription";

type Plan = {
  id: string; name: string; price: number; gross: number; gstApplies: boolean; gstPct: number;
  buckets: { service: string; label: string; cycles: number; kgPerCycle: number }[];
};

export default function WalletClient({ plans, pending }: { plans: Plan[]; pending: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [chosen, setChosen] = useState<Plan | null>(null);
  const [method, setMethod] = useState<"upi" | "cash">("upi");
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  const request = async () => {
    if (!chosen) return;
    setLoading(true);
    const r = await requestSubscription(chosen.id, method);
    setLoading(false);
    if (!r.ok) return toast(r.error || "Couldn't send request", true);
    if (r.code) setCode(r.code);
    else {
      toast("Request sent — pay by UPI at the counter");
      setChosen(null);
      router.refresh();
    }
  };

  const cancelPending = async () => {
    setLoading(true);
    await cancelSubscriptionRequest();
    setLoading(false);
    toast("Request cancelled");
    router.refresh();
  };

  const close = () => { setChosen(null); setCode(null); router.refresh(); };

  return (
    <>
      {pending && (
        <div className="card pad mt2" style={{ background: "var(--amber-soft)", borderColor: "#eedcb8" }}>
          <div className="between">
            <div>
              <div className="h-sm" style={{ color: "var(--amber)" }}>"{pending}" — awaiting activation</div>
              <div className="muted" style={{ fontSize: "12px" }}>Pay at the counter and staff will switch it on.</div>
            </div>
            <button className="btn xs sec" onClick={cancelPending} disabled={loading}>Cancel</button>
          </div>
        </div>
      )}

      {plans.map((p) => (
        <div key={p.id} className="card pad mt10">
          <div className="between">
            <div className="h-sm">{p.name}</div>
            <span className="pill">{fmt(p.gross)} / yr</span>
          </div>
          <div className="muted mt4" style={{ fontSize: "12px" }}>
            {p.gstApplies ? `${fmt(p.price)} + ${p.gstPct}% GST` : fmt(p.price)}
          </div>
          <div className="mt8">
            {p.buckets.map((b) => (
              <div key={b.service} className="kv" style={{ padding: "3px 0" }}>
                <span className="k" style={{ fontSize: "13.5px" }}>{b.label}</span>
                <span className="mono" style={{ fontSize: "13.5px" }}>{b.cycles} cycles × {b.kgPerCycle} kg</span>
              </div>
            ))}
          </div>
          <button className="btn ghost mt10" onClick={() => { setCode(null); setChosen(p); }} disabled={!!pending}>
            <Svg name="layers" size={16} /> Choose this plan
          </button>
        </div>
      ))}

      <Sheet open={!!chosen} onClose={close}>
        <div className="pad">
          {code ? (
            <div className="center">
              <h2 style={{ marginBottom: "8px" }}>Show this at the counter</h2>
              <p className="muted" style={{ fontSize: "13px", marginBottom: "16px" }}>
                Pay {fmt(chosen?.gross || 0)} cash and show this code — staff will activate your plan.
              </p>
              <div className="otp-box">{code}</div>
              <button className="btn mt20" onClick={close}>Done</button>
            </div>
          ) : chosen && (
            <>
              <h2 style={{ marginBottom: "6px" }}>{chosen.name}</h2>
              <p className="muted" style={{ fontSize: "13px", marginBottom: "14px" }}>
                Activates once staff confirm your payment at the counter.
              </p>
              <div className="card pad" style={{ background: "var(--teal-tint)", marginBottom: "16px" }}>
                {chosen.buckets.map((b) => (
                  <div key={b.service} className="kv"><span className="k">{b.label}</span><span className="mono">{b.cycles} × {b.kgPerCycle} kg</span></div>
                ))}
                <div className="kv total"><span>To pay</span><span className="mono">{fmt(chosen.gross)}</span></div>
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
