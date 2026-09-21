"use client";
/* Plans are shown to students for information only.

   Buying one happens at the counter: money changes hands in person, so the
   record of it is created by the staff member who took it. The server refuses
   a student-initiated purchase regardless of what this screen does — this is
   the honest presentation of that rule, not the enforcement of it. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sheet } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { fmt } from "@/lib/format";

type Plan = {
  id: string; name: string; price: number; gross: number; gstApplies: boolean; gstPct: number;
  buckets: { service: string; label: string; cycles: number; kgPerCycle: number }[];
};

export default function WalletClient({ plans, pending }: { plans: Plan[]; pending: string | null }) {
  const router = useRouter();
  const [chosen, setChosen] = useState<Plan | null>(null);
  const close = () => { setChosen(null); router.refresh(); };

  return (
    <>
      {pending && (
        <div className="card pad mt2" style={{ background: "var(--amber-soft)", borderColor: "#eedcb8" }}>
          <div className="h-sm" style={{ color: "var(--amber)" }}>&quot;{pending}&quot; — awaiting activation</div>
          <div className="muted" style={{ fontSize: "12px" }}>Pay at the counter and staff will switch it on.</div>
        </div>
      )}

      <div className="card pad mt10" style={{ background: "var(--teal-tint)" }}>
        <div className="row gap8">
          <span style={{ color: "var(--teal-dark)" }}><Svg name="alert" size={18} /></span>
          <div style={{ fontSize: "12.5px", color: "var(--teal-dark)" }}>
            Plans are set up at the counter. Have a look here, then ask staff to activate the one you want.
          </div>
        </div>
      </div>

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
          <button className="btn ghost mt10" onClick={() => setChosen(p)}>
            <Svg name="layers" size={16} /> What&apos;s included
          </button>
        </div>
      ))}

      <Sheet open={!!chosen} onClose={close}>
        <div className="pad">
          {chosen && (
            <>
              <h2 style={{ marginBottom: "6px" }}>{chosen.name}</h2>
              <p className="muted" style={{ fontSize: "13px", marginBottom: "14px" }}>
                Ask at the counter to start this plan. Staff take the payment and activate it on the spot.
              </p>
              <div className="card pad" style={{ background: "var(--teal-tint)", marginBottom: "16px" }}>
                {chosen.buckets.map((b) => (
                  <div key={b.service} className="kv"><span className="k">{b.label}</span><span className="mono">{b.cycles} × {b.kgPerCycle} kg</span></div>
                ))}
                <div className="kv total"><span>Price</span><span className="mono">{fmt(chosen.gross)}</span></div>
              </div>
              <div className="muted" style={{ fontSize: "12.5px", marginBottom: "14px" }}>
                Your bag and wash day are set up at the same time. Questions? support@fabricfold.in
              </div>
              <button className="btn" onClick={close}>Got it</button>
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}
