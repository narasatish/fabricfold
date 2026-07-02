"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { fmt, dateStr } from "@/lib/format";
import { useToast, Seg, Sheet, Switch } from "@/components/chrome";

type AppConfig = {
  id: string;
  gstPct: number;
  plan: any;
  rates: any;
  payment: any;
  settings: any;
};

type College = {
  id: string;
  name: string;
  address: string;
  features: Record<string, boolean>;
};

type Staff = {
  id: string;
  name: string;
  phone: string;
  role: number;
  collegeId: string;
};

type Payslip = {
  id: string;
  month: string;
  net: number;
  staff: { name: string };
};

export default function StaffAdminClient({
  appConfig,
  colleges,
  staff,
  payslips,
  currentRole,
}: {
  appConfig: AppConfig | null;
  colleges: College[];
  staff: Staff[];
  payslips: Payslip[];
  currentRole: number;
}) {
  const toast = useToast();
  const [showRatesSheet, setShowRatesSheet] = useState(false);
  const [showPlanSheet, setShowPlanSheet] = useState(false);
  const [showPaymentSheet, setShowPaymentSheet] = useState(false);
  const [showCollegeSheet, setShowCollegeSheet] = useState(false);
  const [showStaffSheet, setShowStaffSheet] = useState(false);

  const handleSaveRates = async (gst: number) => {
    try {
      // TODO: call saveRates action
      toast("Rates updated");
      setShowRatesSheet(false);
    } catch (err) {
      toast("Failed to save rates", true);
    }
  };

  return (
    <div className="pad">
      {/* Rates & GST */}
      <div className="sec-title">Settings</div>

      <button className="card-btn mt12" onClick={() => setShowRatesSheet(true)}>
        <div className="icon-tile">
          <Svg name="tag" size={20} />
        </div>
        <div style={{ flex: 1 }}>
          <div className="h-sm">Rates & GST</div>
          <div className="muted" style={{ fontSize: "12px" }}>
            Service pricing, GST %
          </div>
        </div>
        <Svg name="chevR" size={18} />
      </button>

      <button className="card-btn mt8" onClick={() => setShowPlanSheet(true)}>
        <div className="icon-tile" style={{ background: "var(--blue-soft)", color: "var(--blue)" }}>
          <Svg name="wallet" size={20} />
        </div>
        <div style={{ flex: 1 }}>
          <div className="h-sm">Subscription plan</div>
          <div className="muted" style={{ fontSize: "12px" }}>
            Price, cycles, weight per cycle
          </div>
        </div>
        <Svg name="chevR" size={18} />
      </button>

      <button className="card-btn mt8" onClick={() => setShowPaymentSheet(true)}>
        <div className="icon-tile" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}>
          <Svg name="card" size={20} />
        </div>
        <div style={{ flex: 1 }}>
          <div className="h-sm">Payment & bank</div>
          <div className="muted" style={{ fontSize: "12px" }}>
            UPI ID, bank details, gateway key
          </div>
        </div>
        <Svg name="chevR" size={18} />
      </button>

      {/* Colleges (Owner only) */}
      {currentRole >= 4 && (
        <>
          <div className="sec-title mt20">Colleges</div>
          {colleges.map((c) => (
            <div key={c.id} className="card pad mt10">
              <div className="h-sm">{c.name}</div>
              <div className="muted" style={{ fontSize: "12px", marginTop: "4px" }}>
                {c.address}
              </div>
            </div>
          ))}
          <button className="btn mt12" onClick={() => setShowCollegeSheet(true)}>
            <Svg name="plus" size={18} /> Add college
          </button>
        </>
      )}

      {/* Staff roles (Admin+) */}
      {currentRole >= 3 && (
        <>
          <div className="sec-title mt20">Staff</div>
          {staff.map((s) => (
            <div key={s.id} className="card pad mt10">
              <div className="between">
                <div>
                  <div className="h-sm">{s.name}</div>
                  <div className="muted" style={{ fontSize: "12px", marginTop: "4px" }}>
                    {["Counter", "Manager", "Admin", "Owner"][s.role - 1] || "Unknown"}
                  </div>
                </div>
              </div>
            </div>
          ))}
          <button className="btn mt12" onClick={() => setShowStaffSheet(true)}>
            <Svg name="plus" size={18} /> Add staff
          </button>
        </>
      )}

      {/* Payroll (Admin+) */}
      {currentRole >= 3 && (
        <>
          <div className="sec-title mt20">Payroll</div>
          {payslips.slice(0, 5).map((p) => (
            <div key={p.id} className="card pad mt10">
              <div className="kv">
                <span className="k">{p.staff.name}</span>
                <span className="mono">{fmt(p.net)}</span>
              </div>
              <div className="muted" style={{ fontSize: "12px", marginTop: "4px" }}>
                {p.month}
              </div>
            </div>
          ))}
        </>
      )}

      {/* Sheets */}
      <Sheet open={showRatesSheet} onClose={() => setShowRatesSheet(false)}>
        <div className="pad">
          <h2>Rates & GST</h2>
          <div className="field mt16">
            <label>GST %</label>
            <input className="input" type="number" placeholder="18" defaultValue={appConfig?.gstPct || 18} />
          </div>
          <button className="btn mt16">Save rates</button>
        </div>
      </Sheet>

      <Sheet open={showPlanSheet} onClose={() => setShowPlanSheet(false)}>
        <div className="pad">
          <h2>Subscription plan</h2>
          <div className="field mt16">
            <label>Price (₹)</label>
            <input className="input" type="number" placeholder="6800" defaultValue={appConfig?.plan?.price || 6800} />
          </div>
          <div className="field">
            <label>Cycles per plan</label>
            <input className="input" type="number" placeholder="34" defaultValue={appConfig?.plan?.cycles || 34} />
          </div>
          <button className="btn mt16">Save plan</button>
        </div>
      </Sheet>

      <Sheet open={showPaymentSheet} onClose={() => setShowPaymentSheet(false)}>
        <div className="pad">
          <h2>Payment & bank</h2>
          <div className="field mt16">
            <label>UPI ID</label>
            <input className="input" type="text" placeholder="abc@oicici" defaultValue={appConfig?.payment?.upiId || ""} />
          </div>
          <button className="btn mt16">Save payment details</button>
        </div>
      </Sheet>
    </div>
  );
}
