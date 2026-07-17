"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/chrome";
import { Seg, Switch } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { fmt } from "@/lib/format";
import { placeOrder } from "@/lib/actions/orders";
import { EXPRESS_PCT, expressSurcharge } from "@/lib/money";

type EnabledService = { key: string; flag: string; label: string };

export default function OrderNewClient({
  enabledServices,
  currentService,
  rateItems,
  gstPct,
  expressEnabled,
  reorderItems,
}: {
  enabledServices: EnabledService[];
  currentService: string;
  rateItems: [string, number][];
  gstPct: number;
  expressEnabled: boolean;
  reorderItems: { label: string; qty: number }[];
}) {
  const router = useRouter();
  const toast = useToast();

  const [service, setService] = useState(currentService);
  const [quantities, setQuantities] = useState<Record<string, number>>(() => {
    const q: Record<string, number> = {};
    rateItems.forEach(([label]) => {
      q[label] = reorderItems.find((i) => i.label === label)?.qty || 0;
    });
    return q;
  });
  const [express, setExpress] = useState(false);
  const [loading, setLoading] = useState(false);

  // Calculate totals
  const items = rateItems
    .filter(([label]) => quantities[label] > 0)
    .map(([label, rate]) => ({ label, rate, qty: quantities[label] }));

  const subtotal = items.reduce((s, i) => s + i.rate * i.qty, 0);
  const surcharge = express ? expressSurcharge(subtotal) : 0;
  const gst = Math.round((subtotal + surcharge) * (gstPct / 100));
  const total = subtotal + surcharge + gst;
  const pieces = items.reduce((s, i) => s + i.qty, 0);

  const handleQtyChange = (label: string, delta: number) => {
    setQuantities((q) => ({
      ...q,
      [label]: Math.max(0, (q[label] || 0) + delta),
    }));
  };

  const handleSubmit = async () => {
    if (pieces === 0) {
      toast("Add at least one piece", true);
      return;
    }
    setLoading(true);
    const r = await placeOrder({
      service,
      items: rateItems
        .filter(([label]) => quantities[label] > 0)
        .map(([label]) => ({ label, qty: quantities[label] })),
      express,
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
        onChange={setService}
      />

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
                  +{Math.round(EXPRESS_PCT * 100)}% of order value{surcharge > 0 ? ` · ${fmt(surcharge)}` : ""}
                </div>
              </div>
            </div>
            <Switch on={express} onToggle={() => setExpress(!express)} />
          </div>
        </>
      )}

      {/* Bill preview */}
      <div className="card pad mt20">
        <div className="kv">
          <span className="k">Subtotal ({pieces} pcs)</span>
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

      <button className="btn mt16" disabled={pieces === 0 || loading} onClick={handleSubmit}>
        {loading ? "Creating…" : "Pre-book order"}
      </button>
      <div className="center muted mt12" style={{ fontSize: "12px" }}>
        You'll get an Order ID to show at the counter
      </div>
    </>
  );
}
