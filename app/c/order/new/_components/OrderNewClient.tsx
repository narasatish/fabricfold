"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/chrome";
import { Seg, Switch } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { fmt } from "@/lib/format";
import { placeOrder } from "@/lib/actions/orders";
import { collegeExpressFee, CYCLE_RATES, CYCLE_KG_LIMIT, isCycleService, collegeUsesCycleBasedPricing } from "@/lib/money";

type EnabledService = { key: string; flag: string; label: string };
type Slot = { startAt: string; endAt: string; dateStr: string; timeLabel: string; left: number; full: boolean };

export default function OrderNewClient({
  enabledServices,
  currentService,
  allRates,
  gstPct,
  expressEnabled,
  hasActiveSubscription,
  collegeUsesCycles,
  collegeExpressOverride,
  reorderItems,
  slots,
  slotDayLabels,
}: {
  enabledServices: EnabledService[];
  currentService: string;
  allRates: Record<string, [string, number][]>;
  gstPct: number;
  expressEnabled: boolean;
  hasActiveSubscription: boolean;
  collegeUsesCycles: boolean;
  collegeExpressOverride: Record<string, number> | null;
  reorderItems: { label: string; qty: number }[];
  slots: Slot[];
  slotDayLabels: Record<string, string>;
}) {
  const router = useRouter();
  const toast = useToast();

  const [service, setService] = useState(currentService);
  /* Derived per selection. The old single-service prop froze the FIRST
     service's items, so switching the tab quoted wrong names and prices. */
  const rateItems = allRates[service] ?? [];
  const [quantities, setQuantities] = useState<Record<string, number>>(() => {
    const q: Record<string, number> = {};
    (allRates[currentService] ?? []).forEach(([label]) => {
      q[label] = reorderItems.find((i) => i.label === label)?.qty || 0;
    });
    return q;
  });
  const [cycles, setCycles] = useState(1);
  const [express, setExpress] = useState(false);
  const [dropSlotAt, setDropSlotAt] = useState<string>("");
  const [loading, setLoading] = useState(false);

  // Calculate totals
  const items = rateItems
    .filter(([label]) => quantities[label] > 0)
    .map(([label, rate]) => ({ label, rate, qty: quantities[label] }));

  // Determine if this service uses cycle-based pricing: only for services that
  // are defined in CYCLE_RATES AND the college doesn't have per-piece override
  const cycleBased = isCycleService(service) && collegeUsesCycles;
  const subtotal = cycleBased ? cycles * CYCLE_RATES[service] : items.reduce((s, i) => s + i.rate * i.qty, 0);
  // Flat same-day fee for every service (owner, Sep 2026) — no percentage.
  const surcharge = express ? collegeExpressFee(service, collegeExpressOverride) : 0;
  // Cycle-based orders are FINAL — Rs 200 means Rs 200, no GST line on cycle orders.
  const gst = cycleBased ? 0 : Math.round((subtotal + surcharge) * (gstPct / 100));
  const total = subtotal + surcharge + gst;
  const pieces = items.reduce((s, i) => s + i.qty, 0);

  const handleQtyChange = (label: string, delta: number) => {
    setQuantities((q) => ({
      ...q,
      [label]: Math.max(0, (q[label] || 0) + delta),
    }));
  };

  const handleSubmit = async () => {
    if (!cycleBased && pieces === 0) {
      toast("Add at least one piece", true);
      return;
    }
    setLoading(true);
    const r = await placeOrder({
      service,
      cycles: cycleBased ? cycles : undefined,
      items: cycleBased
        ? []
        : rateItems
            .filter(([label]) => quantities[label] > 0)
            .map(([label]) => ({ label, qty: quantities[label] })),
      express,
      dropSlotAt: dropSlotAt || undefined,
    });
    setLoading(false);

    if (!r.ok) {
      toast(r.error, true);
      return;
    }
    toast("Order pre-booked · " + r.id);
    router.push(`/c/orders/${r.id}`);
  };

  return (
    <>
      {/* Service selector */}
      <Seg<string>
        options={enabledServices.map((s) => [s.key, s.label])}
        value={service}
        onChange={(sv) => { setService(sv); setQuantities({}); }}
      />

      {cycleBased ? (
        <>
          <div className="muted mt12" style={{ fontSize: "12.5px" }}>
            One cycle = up to {CYCLE_KG_LIMIT} kg. A heavier bag can simply use more cycles —
            your choice; anything over the allowance is ₹50 per kg at the counter.
          </div>
          <div className="list mt12">
            <div className="list-item">
              <div style={{ flex: 1 }}>
                <div className="h-sm">Cycles</div>
                <div className="muted" style={{ fontSize: "12.5px" }}>
                  {fmt(CYCLE_RATES[service])} per cycle · up to {CYCLE_KG_LIMIT * cycles} kg total
                </div>
              </div>
              <div className="step">
                <div className="qty">
                  <button onClick={() => setCycles((c) => Math.max(1, c - 1))}>−</button>
                  <span className="mono">{cycles}</span>
                  <button onClick={() => setCycles((c) => Math.min(10, c + 1))}>+</button>
                </div>
              </div>
            </div>
          </div>
          {hasActiveSubscription && (
            <div className="muted mt8" style={{ fontSize: "12px", padding: "0 4px" }}>
              On a plan? Staff can burn {cycles === 1 ? "this cycle" : `these ${cycles} cycles`} from it at drop-off instead of charging you.
            </div>
          )}
        </>
      ) : (
      <>
      <div className="muted mt12" style={{ fontSize: "12.5px" }}>
        Add the pieces you plan to drop off. Counter staff will confirm the actual count on arrival.
      </div>

      {/* Items list */}
      <div className="list mt12">
        {rateItems.map(([label, rate]) => {
          const q = quantities[label] || 0;
          return (
            <div key={label} className="list-item">
              <div style={{ flex: 1 }}>
                <div className="h-sm">{label}</div>
                <div className="muted" style={{ fontSize: "12.5px" }}>
                  {fmt(rate)} / piece
                </div>
              </div>
              <div className="step">
                <div className="qty">
                  <button onClick={() => handleQtyChange(label, -1)}>−</button>
                  <span className="mono">{q}</span>
                  <button onClick={() => handleQtyChange(label, 1)}>+</button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      </>
      )}

      {/* Express option */}
      {expressEnabled && (
        <>
          <div className="sec-title mt20">Options</div>
          <div className="chip-toggle">
            <div className="row gap8">
              <span style={{ color: "var(--amber)" }}>
                <Svg name="bolt" size={20} />
              </span>
              <div>
                <div className="h-sm">Express (same-day)</div>
                <div className="muted" style={{ fontSize: "12px" }}>
                  Flat {fmt(collegeExpressFee(service, collegeExpressOverride))} — same-day turnaround
                </div>
              </div>
            </div>
            <Switch on={express} onToggle={() => setExpress(!express)} />
          </div>
          {express && hasActiveSubscription && (
            <div className="muted mt8" style={{ fontSize: "12px", padding: "0 4px" }}>
              Using a plan cycle for this order? The cycle already covers the wash — you'd pay just the flat {fmt(collegeExpressFee(service, collegeExpressOverride))} same-day fee in cash at pickup, not the surcharge above.
            </div>
          )}
        </>
      )}

      {/* Drop-off slot — only shown when the campus has windows configured */}
      {slots.length > 0 && (
        <>
          <div className="sec-title mt20">Drop-off slot</div>
          <div className="muted" style={{ fontSize: "12.5px", padding: "0 4px 10px" }}>
            Pick a window to bring your clothes in — skips the counter queue. Optional.
          </div>
          <div className="card pad">
            {Object.entries(
              slots.reduce<Record<string, Slot[]>>((acc, s) => {
                (acc[s.dateStr] ||= []).push(s);
                return acc;
              }, {}),
            ).map(([dateStr, daySlots]) => (
              <div key={dateStr} style={{ marginBottom: 12 }}>
                <div className="label" style={{ marginBottom: 8 }}>{slotDayLabels[dateStr] || dateStr}</div>
                <div className="row wrap gap8">
                  {daySlots.map((s) => {
                    const selected = dropSlotAt === s.startAt;
                    return (
                      <button
                        key={s.startAt}
                        disabled={s.full}
                        onClick={() => setDropSlotAt(selected ? "" : s.startAt)}
                        className="card"
                        style={{
                          padding: "9px 12px", textAlign: "left", cursor: s.full ? "not-allowed" : "pointer",
                          opacity: s.full ? 0.45 : 1,
                          borderColor: selected ? "var(--teal)" : "var(--line)",
                          background: selected ? "var(--teal-tint)" : "var(--card)",
                        }}
                      >
                        <div className="h-sm" style={{ fontSize: 13, color: selected ? "var(--teal-dark)" : undefined }}>
                          {s.timeLabel}
                        </div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          {s.full ? "Full" : `${s.left} left`}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {dropSlotAt && (
              <button className="btn xs sec" onClick={() => setDropSlotAt("")} style={{ width: "auto" }}>
                Clear slot
              </button>
            )}
          </div>
        </>
      )}

      {/* Bill preview */}
      <div className="card pad mt20">
        <div className="kv">
          <span className="k">Subtotal ({cycleBased ? `${cycles} cycle${cycles === 1 ? "" : "s"}` : `${pieces} pcs`})</span>
          <span className="mono">{fmt(subtotal)}</span>
        </div>
        {surcharge > 0 && (
          <div className="kv">
            <span className="k">Express surcharge</span>
            <span className="mono">{fmt(surcharge)}</span>
          </div>
        )}
        {gstPct > 0 && (
          <div className="kv">
            <span className="k">GST ({gstPct}%)</span>
            <span className="mono">{fmt(gst)}</span>
          </div>
        )}
        <div className="kv total">
          <span>Estimated total</span>
          <span className="mono">{fmt(total)}</span>
        </div>
      </div>

      {/* pieces is ALWAYS 0 on a cycle order — gating on it left Pre-book
          permanently dead for the two main services. Found by the owner on
          their own phone, which is the review no test suite replaces. */}
      <button className="btn mt16" disabled={loading || (!cycleBased && pieces === 0)} onClick={handleSubmit}>
        {loading ? "Creating…" : "Pre-book order"}
      </button>
      <div className="center muted mt12" style={{ fontSize: "12px" }}>
        You'll get an Order ID to show at the counter
      </div>
      {/* Terms §8 in one line, right where the promise is made — the full
          policy is rarely read at order time, but the "not a guarantee"
          caveat matters most exactly here. */}
      <div className="center muted mt6" style={{ fontSize: "11.5px" }}>
        {express ? "Express is same-day" : "Standard turnaround is about 48 hours"} — our target, occasionally delayed
        by things outside our control. <a href="/terms">Terms</a>
      </div>
    </>
  );
}
