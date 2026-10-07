"use client";
/* Students do not see plan prices or buy anything here. Plans are sold and
   activated at the counter, where the payment is taken and recorded by the
   staff member. The server refuses a student-initiated purchase regardless. */
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";

export default function WalletClient({ pending }: { pending: string | null }) {
  const router = useRouter();

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
            Plans are bought and activated at the counter. Ask staff for a plan.
          </div>
        </div>
        <button className="btn ghost mt8" onClick={() => router.refresh()}>Refresh</button>
      </div>
    </>
  );
}
