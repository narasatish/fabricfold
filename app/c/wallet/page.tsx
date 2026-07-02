import { requireStudent } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import { fmt, dateStr } from "@/lib/format";
import Link from "next/link";
import { Svg } from "@/components/icons";
import WalletClient from "./_components/WalletClient";

export default async function WalletPage() {
  const student = await requireStudent();
  const appConfig = await db.appConfig.findUnique({ where: { id: "main" } });

  const sub = student.subscription;
  const plan = appConfig?.plan as unknown as { price: number; cycles: number; kgPerCycle: number };
  const gst = Number(appConfig?.gstPct || 18);
  const planTotal = Math.round(plan.price * (1 + gst / 100));

  // Get compensations and credits
  const compensations = await db.compensation.findMany({
    where: { studentId: student.id, method: "credit" },
    orderBy: { at: "desc" },
  });

  const creditUses = await db.creditUse.findMany({
    where: { studentId: student.id },
    orderBy: { at: "desc" },
  });

  // Build ledger
  const ledger = [
    ...compensations.map((c) => ({
      dir: 1 as const,
      amount: Number(c.amount),
      at: c.at,
      label: { damage: "Damage compensation", stain: "Re-do / stain credit", missing: "Missing item credit", goodwill: "Goodwill credit", manual: "Credit adjustment" }[c.kind] || "Credit added",
    })),
    ...creditUses.map((u) => ({
      dir: -1 as const,
      amount: Number(u.amount),
      at: u.at,
      label: u.orderId ? `Used on order #${u.orderId.slice(-4)}` : "Used towards a bill",
    })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <div className="screen">
      <TopBar title="Wallet" />

      <div className="pad">
        {/* Subscription section */}
        <div className="sec-title">Subscription</div>
        {sub?.active ? (
          <div className="card pad">
            <div className="between">
              <span className="pill">Active</span>
              <span className="muted" style={{ fontSize: "12.5px" }}>
                Renews {sub.expiresAt ? dateStr(sub.expiresAt) : "—"}
              </span>
            </div>
            <div className="mt12">
              <div className="big-num">
                {sub.cyclesTotal - sub.cyclesUsed}
                <span style={{ fontSize: "16px", fontWeight: 600, color: "var(--muted)" }}>
                  {" "}/ {sub.cyclesTotal} cycles
                </span>
              </div>
              <div className="muted" style={{ fontSize: "13px", marginTop: "4px" }}>
                1 drop-off = 1 cycle · up to {plan.kgPerCycle}kg · covers Wash & Iron
              </div>
            </div>
            <div style={{ height: "8px", background: "var(--line)", borderRadius: "4px", marginTop: "14px", overflow: "hidden" }}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.round(((sub.cyclesTotal - sub.cyclesUsed) / sub.cyclesTotal) * 100)}%`,
                  background: "var(--teal)",
                }}
              />
            </div>
          </div>
        ) : (
          <div className="card pad">
            <div className="h-md">Annual plan</div>
            <div className="muted mt4" style={{ fontSize: "13.5px" }}>
              {plan.cycles} cycles a year · up to {plan.kgPerCycle}kg per drop-off · covers unlimited Wash & Iron within your cycles.
            </div>
            <div className="row gap8 mt16" style={{ alignItems: "baseline" }}>
              <span className="big-num">{fmt(planTotal)}</span>
              <span className="muted">/ year</span>
            </div>
            <div className="muted" style={{ fontSize: "12px" }}>
              {fmt(plan.price)} + {gst}% GST
            </div>
            <Link href="#" className="btn mt16">
              Get the plan
            </Link>
            <div className="muted center mt8" style={{ fontSize: "11.5px" }}>
              Activated after staff approval
            </div>
          </div>
        )}

        {/* Credits section */}
        <div className="sec-title mt20">Credits</div>
        <div className="card pad">
          <div className="between">
            <div>
              <div className="label">Balance</div>
              <div className="big-num mt4" style={{ color: "var(--teal-dark)" }}>
                {fmt(student.credits)}
              </div>
            </div>
            <div className="icon-tile" style={{ width: "52px", height: "52px" }}>
              <Svg name="gift" size={26} />
            </div>
          </div>
          <div className="muted mt12" style={{ fontSize: "12.5px" }}>
            Credits carry forward and can be used towards dry cleaning & other bills.
          </div>
          {ledger.length > 0 && (
            <>
              <div style={{ height: "1px", background: "var(--line)", margin: "14px 0" }} />
              <div className="label" style={{ marginBottom: "8px" }}>
                History
              </div>
              {ledger.map((e, i) => (
                <div key={i} className="kv">
                  <span className="k">
                    {e.label} <span className="muted" style={{ fontSize: "11px" }}>· {dateStr(e.at.getTime())}</span>
                  </span>
                  <span className="mono" style={{ fontWeight: 600, color: e.dir > 0 ? "var(--teal-dark)" : "var(--muted)" }}>
                    {e.dir > 0 ? "+" : "−"}
                    {fmt(e.amount)}
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
