import { requireStudent } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import { fmt, dateStr } from "@/lib/format";
import { Svg } from "@/components/icons";
import WalletClient from "./_components/WalletClient";

const SERVICE_LABEL: Record<string, string> = { washIron: "Wash & Iron", washFold: "Wash & Fold", ironOnly: "Iron Only", dryClean: "Dry Clean" };
type Bucket = { service: string; cycles: number; used?: number; kgPerCycle: number };

export default async function WalletPage() {
  const student = await requireStudent();
  const appConfig = await db.appConfig.findUnique({ where: { id: "main" } });

  const sub = student.subscription;
  const gstEnabled = (appConfig?.settings as Record<string, unknown>)?.gstEnabled !== false;
  const gstPct = Number(appConfig?.gstPct || 18);

  // This college's plans (each with the exact amount to pay)
  const plans = (await db.plan.findMany({ where: { collegeId: student.collegeId, active: true }, orderBy: { price: "asc" } })).map((p) => {
    const gstApplies = gstEnabled && !p.gstFree;
    const price = Number(p.price);
    return {
      id: p.id,
      name: p.name,
      price,
      gross: price + (gstApplies ? Math.round(price * gstPct / 100) : 0),
      gstApplies,
      gstPct,
      buckets: (p.buckets as unknown as Bucket[]).map((b) => ({ ...b, label: SERVICE_LABEL[b.service] || b.service })),
    };
  });

  const subBuckets = ((sub?.buckets as unknown as Bucket[]) || []).map((b) => ({ ...b, used: b.used || 0, label: SERVICE_LABEL[b.service] || b.service }));

  // Credits ledger
  const compensations = await db.compensation.findMany({ where: { studentId: student.id, method: "credit" }, orderBy: { at: "desc" } });
  const creditUses = await db.creditUse.findMany({ where: { studentId: student.id }, orderBy: { at: "desc" } });
  const ledger = [
    ...compensations.map((c) => ({
      dir: 1 as const, amount: Number(c.amount), at: c.at,
      label: { damage: "Damage compensation", stain: "Re-do / stain credit", missing: "Missing item credit", goodwill: "Goodwill credit", manual: "Credit adjustment", topup: "Money added" }[c.kind] || "Credit added",
    })),
    ...creditUses.map((u) => ({ dir: -1 as const, amount: Number(u.amount), at: u.at, label: u.orderId ? `Used on order #${u.orderId.slice(-4)}` : "Used towards a bill" })),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  return (
    <div className="screen">
      <TopBar title="Wallet" />

      <div className="pad">
        {/* Subscription */}
        <div className="sec-title">Subscription</div>
        {sub?.active ? (
          <div className="card pad">
            <div className="between">
              <span className="pill">{sub.plan}</span>
              <span className="muted" style={{ fontSize: "12.5px" }}>Renews {sub.expiresAt ? dateStr(sub.expiresAt.getTime()) : "—"}</span>
            </div>
            {subBuckets.length ? (
              subBuckets.map((b) => (
                <div key={b.service} className="mt12">
                  <div className="between">
                    <span className="h-sm">{b.label}</span>
                    <span className="mono muted" style={{ fontSize: "13px" }}>{b.cycles - b.used} / {b.cycles} left</span>
                  </div>
                  <div style={{ height: "8px", background: "var(--line)", borderRadius: "4px", marginTop: "6px", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${Math.round(((b.cycles - b.used) / b.cycles) * 100)}%`, background: "var(--teal)" }} />
                  </div>
                  <div className="muted mt4" style={{ fontSize: "11.5px" }}>1 drop-off = 1 cycle · up to {b.kgPerCycle} kg</div>
                </div>
              ))
            ) : (
              <div className="mt12">
                <div className="big-num">
                  {sub.cyclesTotal - sub.cyclesUsed}
                  <span style={{ fontSize: "16px", fontWeight: 600, color: "var(--muted)" }}> / {sub.cyclesTotal} cycles</span>
                </div>
                <div style={{ height: "8px", background: "var(--line)", borderRadius: "4px", marginTop: "14px", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${Math.round(((sub.cyclesTotal - sub.cyclesUsed) / Math.max(1, sub.cyclesTotal)) * 100)}%`, background: "var(--teal)" }} />
                </div>
              </div>
            )}
          </div>
        ) : plans.length ? (
          <WalletClient plans={plans} pending={sub && !sub.active ? sub.plan : null} />
        ) : (
          <div className="card pad center muted" style={{ fontSize: "13.5px" }}>No subscription plans at your campus yet.</div>
        )}

        {/* Credits */}
        <div className="sec-title mt20">Credits</div>
        <div className="card pad">
          <div className="between">
            <div>
              <div className="label">Balance</div>
              <div className="big-num mt4" style={{ color: "var(--teal-dark)" }}>{fmt(Number(student.credits))}</div>
            </div>
            <div className="icon-tile" style={{ width: "52px", height: "52px" }}><Svg name="gift" size={26} /></div>
          </div>
          <div className="muted mt12" style={{ fontSize: "12.5px" }}>Credits carry forward and can be used towards any bill.</div>
          {ledger.length > 0 && (
            <>
              <div style={{ height: "1px", background: "var(--line)", margin: "14px 0" }} />
              <div className="label" style={{ marginBottom: "8px" }}>History</div>
              {ledger.map((e, i) => (
                <div key={i} className="kv">
                  <span className="k">{e.label} <span className="muted" style={{ fontSize: "11px" }}>· {dateStr(e.at.getTime())}</span></span>
                  <span className="mono" style={{ fontWeight: 600, color: e.dir > 0 ? "var(--teal-dark)" : "var(--muted)" }}>
                    {e.dir > 0 ? "+" : "−"}{fmt(e.amount)}
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
