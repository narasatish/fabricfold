"use client";
/* Admin hub — rates & GST, plan, payment details, colleges + feature flags,
   staff roles, payroll, report settings. All wired to server actions. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { fmt } from "@/lib/format";
import { useToast, Sheet, Switch, Seg } from "@/components/chrome";
import {
  saveRates, savePlan, togglePlan, savePaymentConfig, saveSettings,
  toggleFeature, saveCollege, deleteCollege, saveStaff, createPayslip,
} from "@/lib/actions/admin";

const SERVICE_LABEL: Record<string, string> = { washIron: "Wash & Iron", washFold: "Wash & Fold", ironOnly: "Iron Only", dryClean: "Dry Clean" };
type PlanBucket = { service: string; cycles: number; kgPerCycle: number };
type PlanRow = { id: string; collegeId: string; name: string; price: number; gstFree: boolean; active: boolean; buckets: PlanBucket[] };

type Rates = Record<string, { label: string; items: [string, number][] }>;
type Props = {
  config: {
    gstPct: number;
    plan: { price: number; cycles: number; kgPerCycle: number };
    rates: Rates;
    payment: { upiId: string; payeeName: string; bankName: string; accountName: string; accountNo: string; ifsc: string; gatewayKey: string };
    settings: { reportEmail?: string; dailyEmail?: boolean; sendHour?: number; openingFloat?: number; gstEnabled?: boolean };
  };
  colleges: { id: string; name: string; address: string; features: Record<string, boolean> }[];
  staff: { id: string; name: string; phone: string; role: number; collegeId: string | null }[];
  payslips: { id: string; number: string; month: string; net: number; staffName: string }[];
  plans: PlanRow[];
  currentRole: number;
};

const ROLE_NAMES: Record<number, string> = { 1: "Counter", 2: "Manager", 3: "Admin", 4: "Owner" };
const FEATURES: [string, string][] = [
  ["svc_wash", "Wash & Iron"], ["svc_washfold", "Wash & Fold"], ["svc_iron", "Iron Only"], ["svc_dryclean", "Dry Clean"],
  ["subscriptions", "Subscriptions"], ["credits", "Credits & compensation"],
  ["express", "Express (same-day)"], ["chat", "Chat & complaints"],
];

export default function StaffAdminClient({ config, colleges, staff, payslips, plans, currentRole }: Props) {
  const router = useRouter();
  const toast = useToast();

  const [sheet, setSheet] = useState<null | "rates" | "plan" | "payment" | "settings" | "college" | "staff" | "payslip">(null);
  const [rates, setRates] = useState<Rates>(JSON.parse(JSON.stringify(config.rates)));
  const [gst, setGst] = useState(config.gstPct);
  const [gstOn, setGstOn] = useState(config.settings.gstEnabled !== false);
  const emptyPlan = (collegeId: string): Omit<PlanRow, "active" | "id"> & { id?: string } =>
    ({ id: undefined, collegeId, name: "", price: 0, gstFree: false, buckets: [{ service: "washIron", cycles: 34, kgPerCycle: 7 }] });
  const [planEdit, setPlanEdit] = useState<ReturnType<typeof emptyPlan>>(emptyPlan(colleges[0]?.id || ""));
  const [pay, setPay] = useState({ ...config.payment });
  const [settings, setSettings] = useState({ reportEmail: config.settings.reportEmail || "", dailyEmail: !!config.settings.dailyEmail, sendHour: config.settings.sendHour ?? 21, openingFloat: config.settings.openingFloat ?? 0 });
  const [colEdit, setColEdit] = useState<{ id?: string; name: string; address: string }>({ name: "", address: "" });
  const [stEdit, setStEdit] = useState<{ id?: string; name: string; phone: string; role: number }>({ name: "", phone: "", role: 1 });
  const [slip, setSlip] = useState({ staffId: staff[0]?.id || "", month: new Date().toISOString().slice(0, 7), basic: 0, allowances: 0, deductions: 0, postExpense: true });

  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    const r = await fn();
    if (!r.ok) return toast(r.error || "Failed", true);
    toast(okMsg);
    setSheet(null);
    router.refresh();
  };

  const setRatePrice = (svc: string, idx: number, price: number) => {
    const next = JSON.parse(JSON.stringify(rates)) as Rates;
    next[svc].items[idx][1] = price;
    setRates(next);
  };

  return (
    <div className="pad">
      <div className="sec-title">Settings</div>

      <button className="card-btn mt12" onClick={() => setSheet("rates")}>
        <div className="icon-tile"><Svg name="list" size={20} /></div>
        <div className="grow"><div className="h-sm">Rates &amp; GST</div><div className="muted" style={{ fontSize: 12 }}>Per-item pricing · GST {config.gstPct}%</div></div>
        <Svg name="chevR" size={18} />
      </button>
      <button className="card-btn mt8" onClick={() => setSheet("payment")}>
        <div className="icon-tile" style={{ background: "var(--amber-soft)", color: "var(--amber)" }}><Svg name="card" size={20} /></div>
        <div className="grow"><div className="h-sm">Payment &amp; bank</div><div className="muted" style={{ fontSize: 12 }}>{config.payment.upiId || "UPI not set"}</div></div>
        <Svg name="chevR" size={18} />
      </button>
      <button className="card-btn mt8" onClick={() => setSheet("settings")}>
        <div className="icon-tile" style={{ background: "var(--teal-tint)" }}><Svg name="bell" size={20} /></div>
        <div className="grow"><div className="h-sm">Daily report &amp; drawer</div><div className="muted" style={{ fontSize: 12 }}>{settings.reportEmail || "Report email not set"} · float {fmt(settings.openingFloat)}</div></div>
        <Svg name="chevR" size={18} />
      </button>
      {currentRole >= 4 && (
        <a className="card-btn mt8" href="/api/backup">
          <div className="icon-tile" style={{ background: "var(--blue-soft)", color: "var(--blue)" }}><Svg name="layers" size={20} /></div>
          <div className="grow"><div className="h-sm">Download full backup</div><div className="muted" style={{ fontSize: 12 }}>Complete data snapshot (JSON) · runs nightly automatically too</div></div>
          <Svg name="chevR" size={18} />
        </a>
      )}

      {/* Colleges + feature flags */}
      <div className="sec-title mt20">Colleges &amp; features</div>
      {colleges.map((c) => (
        <div key={c.id} className="card pad mt10">
          <div className="between">
            <div>
              <div className="h-sm">{c.name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{c.address}</div>
            </div>
            {currentRole >= 4 && (
              <div className="row gap6">
                <button className="btn xs sec" onClick={() => { setColEdit({ id: c.id, name: c.name, address: c.address }); setSheet("college"); }}><Svg name="edit" size={13} /></button>
                {colleges.length > 1 && (
                  <button className="btn xs sec" style={{ color: "var(--red)" }} onClick={() => { if (confirm(`Remove ${c.name}?`)) run(() => deleteCollege(c.id), "College removed"); }}><Svg name="trash" size={13} /></button>
                )}
              </div>
            )}
          </div>
          <div className="divider" />
          {FEATURES.map(([key, label]) => (
            <div key={key} className="between" style={{ padding: "7px 0" }}>
              <span style={{ fontSize: 14 }}>{label}</span>
              <Switch
                on={c.features[key] !== false}
                onToggle={async () => {
                  const r = await toggleFeature(c.id, key);
                  if (!r.ok) return toast("Failed", true);
                  toast(`${label} ${r.on ? "enabled" : "disabled"} · ${c.name}`);
                  router.refresh();
                }}
              />
            </div>
          ))}
        </div>
      ))}
      {currentRole >= 4 && (
        <button className="btn ghost mt12" onClick={() => { setColEdit({ name: "", address: "" }); setSheet("college"); }}>
          <Svg name="plus" size={17} /> Add college
        </button>
      )}

      {/* Subscription plans per college */}
      <div className="sec-title mt20">Subscription plans</div>
      {colleges.map((c) => (
        <div key={c.id} className="card pad mt10">
          <div className="between">
            <div className="h-sm">{c.name}</div>
            <button className="btn xs" onClick={() => { setPlanEdit(emptyPlan(c.id)); setSheet("plan"); }}>
              <Svg name="plus" size={13} /> Add plan
            </button>
          </div>
          {plans.filter((p) => p.collegeId === c.id).length === 0 && (
            <div className="muted mt8" style={{ fontSize: "12.5px" }}>No plans yet — students here can&apos;t subscribe until you add one.</div>
          )}
          {plans.filter((p) => p.collegeId === c.id).map((p) => (
            <div key={p.id} className="between mt10" style={{ alignItems: "flex-start" }}>
              <button style={{ textAlign: "left", flex: 1 }} onClick={() => { setPlanEdit({ id: p.id, collegeId: p.collegeId, name: p.name, price: p.price, gstFree: p.gstFree, buckets: JSON.parse(JSON.stringify(p.buckets)) }); setSheet("plan"); }}>
                <div className="h-sm" style={{ opacity: p.active ? 1 : 0.45 }}>
                  {p.name} · {fmt(p.price)}{p.gstFree ? " (no GST)" : ""}
                </div>
                <div className="muted" style={{ fontSize: "12px", opacity: p.active ? 1 : 0.45 }}>
                  {p.buckets.map((b) => `${b.cycles}× ${SERVICE_LABEL[b.service] || b.service} (${b.kgPerCycle}kg)`).join(" + ")}
                </div>
              </button>
              <Switch on={p.active} onToggle={async () => { const r = await togglePlan(p.id); if (!r.ok) return toast("Failed", true); toast(`Plan ${r.active ? "enabled" : "disabled"}`); router.refresh(); }} />
            </div>
          ))}
        </div>
      ))}

      {/* Staff */}
      <div className="sec-title mt20">Staff roles</div>
      <div className="list">
        {staff.map((x) => (
          <button key={x.id} className="list-item tap" style={{ width: "100%", textAlign: "left" }} onClick={() => { setStEdit({ id: x.id, name: x.name, phone: x.phone, role: x.role }); setSheet("staff"); }}>
            <div className="avatar" style={{ width: 38, height: 38, fontSize: 14 }}>{x.name[0]}</div>
            <div className="grow">
              <div className="h-sm">{x.name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{x.phone}</div>
            </div>
            <span className="pill gray">{ROLE_NAMES[x.role]}</span>
          </button>
        ))}
      </div>
      <button className="btn ghost mt12" onClick={() => { setStEdit({ name: "", phone: "", role: 1 }); setSheet("staff"); }}>
        <Svg name="plus" size={17} /> Add staff
      </button>

      {/* Payroll */}
      <div className="sec-title mt20">Payroll</div>
      <button className="btn ghost" onClick={() => setSheet("payslip")}>
        <Svg name="users" size={17} /> Create payslip
      </button>
      {payslips.length > 0 && (
        <div className="list mt12">
          {payslips.map((p) => (
            <div key={p.id} className="list-item">
              <div className="grow">
                <div className="h-sm mono">{p.number}</div>
                <div className="muted" style={{ fontSize: 12 }}>{p.staffName} · {p.month}</div>
              </div>
              <span className="mono" style={{ fontWeight: 650 }}>{fmt(p.net)}</span>
            </div>
          ))}
        </div>
      )}

      {/* ---------- Sheets ---------- */}
      <Sheet open={sheet === "rates"} onClose={() => setSheet(null)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>Rates &amp; GST</div>
        {Object.entries(rates).map(([svc, r]) => (
          <div key={svc} className="card pad" style={{ marginBottom: 12 }}>
            <div className="h-sm" style={{ marginBottom: 8 }}>{r.label}</div>
            {r.items.map(([name, price], i) => (
              <div key={name} className="between" style={{ padding: "5px 0" }}>
                <span style={{ fontSize: 13.5 }}>{name}</span>
                <input className="input" type="number" value={price} style={{ width: 90, height: 38, textAlign: "right" }} onChange={(e) => setRatePrice(svc, i, Number(e.target.value))} />
              </div>
            ))}
          </div>
        ))}
        <div className="chip-toggle" style={{ marginBottom: 14 }}>
          <div>
            <div className="h-sm">Charge GST</div>
            <div className="muted" style={{ fontSize: 12 }}>Off = no GST added anywhere, no tax invoices (for businesses without GST registration)</div>
          </div>
          <Switch on={gstOn} onToggle={() => setGstOn(!gstOn)} />
        </div>
        {gstOn && (
          <div className="field"><label>GST %</label><input className="input" type="number" value={gst} onChange={(e) => setGst(Number(e.target.value))} /></div>
        )}
        <button className="btn" onClick={() => run(() => saveRates(rates, gst, gstOn), "Rates saved")}>Save rates</button>
      </Sheet>

      <Sheet open={sheet === "plan"} onClose={() => setSheet(null)}>
        <div className="h-md" style={{ padding: "0 4px 4px" }}>{planEdit.id ? "Edit plan" : "New plan"}</div>
        <div className="muted" style={{ padding: "0 4px 12px", fontSize: 12.5 }}>
          For {colleges.find((c) => c.id === planEdit.collegeId)?.name} — students there see this plan in their wallet.
        </div>
        <div className="field"><label>Plan name</label><input className="input" placeholder="e.g. Wash & Iron — Annual" value={planEdit.name} onChange={(e) => setPlanEdit({ ...planEdit, name: e.target.value })} /></div>
        <div className="field"><label>Price (₹{planEdit.gstFree ? ", final" : ", before GST"})</label><input className="input" type="number" value={planEdit.price || ""} onChange={(e) => setPlanEdit({ ...planEdit, price: Number(e.target.value) })} /></div>
        <div className="chip-toggle" style={{ marginBottom: 14 }}>
          <div>
            <div className="h-sm">No GST on this plan</div>
            <div className="muted" style={{ fontSize: 12 }}>Price is charged as-is, no tax invoice</div>
          </div>
          <Switch on={planEdit.gstFree} onToggle={() => setPlanEdit({ ...planEdit, gstFree: !planEdit.gstFree })} />
        </div>
        <div className="label" style={{ marginBottom: 8 }}>What the plan includes</div>
        {planEdit.buckets.map((b, i) => (
          <div key={i} className="card pad" style={{ marginBottom: 10, padding: 14 }}>
            <div className="row gap8">
              <select className="input" style={{ flex: 2, height: 42 }} value={b.service} onChange={(e) => { const bs = [...planEdit.buckets]; bs[i] = { ...b, service: e.target.value }; setPlanEdit({ ...planEdit, buckets: bs }); }}>
                {Object.entries(SERVICE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <input className="input" style={{ flex: 1, height: 42 }} type="number" placeholder="cycles" value={b.cycles || ""} onChange={(e) => { const bs = [...planEdit.buckets]; bs[i] = { ...b, cycles: Number(e.target.value) }; setPlanEdit({ ...planEdit, buckets: bs }); }} />
              <input className="input" style={{ flex: 1, height: 42 }} type="number" placeholder="kg" value={b.kgPerCycle || ""} onChange={(e) => { const bs = [...planEdit.buckets]; bs[i] = { ...b, kgPerCycle: Number(e.target.value) }; setPlanEdit({ ...planEdit, buckets: bs }); }} />
              {planEdit.buckets.length > 1 && (
                <button className="action" onClick={() => setPlanEdit({ ...planEdit, buckets: planEdit.buckets.filter((_, j) => j !== i) })}><Svg name="x" size={16} /></button>
              )}
            </div>
            <div className="muted mt4" style={{ fontSize: 11 }}>cycles · kg per drop-off</div>
          </div>
        ))}
        <button className="btn xs sec" onClick={() => setPlanEdit({ ...planEdit, buckets: [...planEdit.buckets, { service: "washFold", cycles: 20, kgPerCycle: 7 }] })}>
          <Svg name="plus" size={13} /> Add another service
        </button>
        <button className="btn mt12" onClick={() => run(() => savePlan(planEdit), "Plan saved")}>Save plan</button>
      </Sheet>

      <Sheet open={sheet === "payment"} onClose={() => setSheet(null)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>Payment &amp; bank details</div>
        {([["upiId", "UPI ID"], ["payeeName", "Payee name"], ["bankName", "Bank"], ["accountName", "Account name"], ["accountNo", "Account number"], ["ifsc", "IFSC"], ["gatewayKey", "Razorpay key id"]] as const).map(([k, label]) => (
          <div key={k} className="field">
            <label>{label}</label>
            <input className="input" value={pay[k] || ""} onChange={(e) => setPay({ ...pay, [k]: e.target.value })} />
          </div>
        ))}
        <button className="btn" onClick={() => run(() => savePaymentConfig(pay), "Payment details saved")}>Save details</button>
      </Sheet>

      <Sheet open={sheet === "settings"} onClose={() => setSheet(null)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>Daily report &amp; drawer</div>
        <div className="field"><label>Owner report email</label><input className="input" type="email" value={settings.reportEmail} onChange={(e) => setSettings({ ...settings, reportEmail: e.target.value })} /></div>
        <div className="chip-toggle" style={{ marginBottom: 15 }}>
          <div><div className="h-sm">Daily email at {settings.sendHour}:00</div><div className="muted" style={{ fontSize: 12 }}>Automatic end-of-day report</div></div>
          <Switch on={settings.dailyEmail} onToggle={() => setSettings({ ...settings, dailyEmail: !settings.dailyEmail })} />
        </div>
        <div className="field"><label>Opening cash float (₹)</label><input className="input" type="number" value={settings.openingFloat} onChange={(e) => setSettings({ ...settings, openingFloat: Number(e.target.value) })} /></div>
        <button className="btn" onClick={() => run(() => saveSettings(settings), "Settings saved")}>Save settings</button>
      </Sheet>

      <Sheet open={sheet === "college"} onClose={() => setSheet(null)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>{colEdit.id ? "Edit college" : "Add college"}</div>
        <div className="field"><label>Name</label><input className="input" value={colEdit.name} onChange={(e) => setColEdit({ ...colEdit, name: e.target.value })} /></div>
        <div className="field"><label>Address</label><input className="input" value={colEdit.address} onChange={(e) => setColEdit({ ...colEdit, address: e.target.value })} /></div>
        <button className="btn" onClick={() => run(() => saveCollege(colEdit), "College saved")}>{colEdit.id ? "Save" : "Create college"}</button>
      </Sheet>

      <Sheet open={sheet === "staff"} onClose={() => setSheet(null)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>{stEdit.id ? "Edit staff" : "Add staff"}</div>
        <div className="field"><label>Name</label><input className="input" value={stEdit.name} onChange={(e) => setStEdit({ ...stEdit, name: e.target.value })} /></div>
        <div className="field"><label>Mobile</label><input className="input" inputMode="numeric" maxLength={10} value={stEdit.phone} onChange={(e) => setStEdit({ ...stEdit, phone: e.target.value })} /></div>
        <div className="field">
          <label>Role</label>
          <select className="input" value={stEdit.role} onChange={(e) => setStEdit({ ...stEdit, role: Number(e.target.value) })}>
            <option value={1}>Counter</option>
            <option value={2}>Manager</option>
            <option value={3}>Admin</option>
            {currentRole >= 4 && <option value={4}>Owner</option>}
          </select>
        </div>
        <button className="btn" onClick={() => run(() => saveStaff({ ...stEdit, collegeId: null }), "Staff saved")}>{stEdit.id ? "Save" : "Create staff account"}</button>
        <div className="muted center mt8" style={{ fontSize: 12 }}>They sign in to the staff app with this mobile.</div>
      </Sheet>

      <Sheet open={sheet === "payslip"} onClose={() => setSheet(null)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>Create payslip</div>
        <div className="field">
          <label>Staff member</label>
          <select className="input" value={slip.staffId} onChange={(e) => setSlip({ ...slip, staffId: e.target.value })}>
            {staff.map((x) => <option key={x.id} value={x.id}>{x.name} · {ROLE_NAMES[x.role]}</option>)}
          </select>
        </div>
        <div className="field"><label>Month</label><input className="input" type="month" value={slip.month} onChange={(e) => setSlip({ ...slip, month: e.target.value })} /></div>
        <div className="field"><label>Basic salary (₹)</label><input className="input" type="number" value={slip.basic || ""} onChange={(e) => setSlip({ ...slip, basic: Number(e.target.value) })} /></div>
        <div className="field"><label>Allowances (₹)</label><input className="input" type="number" value={slip.allowances || ""} onChange={(e) => setSlip({ ...slip, allowances: Number(e.target.value) })} /></div>
        <div className="field"><label>Deductions (₹)</label><input className="input" type="number" value={slip.deductions || ""} onChange={(e) => setSlip({ ...slip, deductions: Number(e.target.value) })} /></div>
        <div className="card pad" style={{ marginBottom: 12 }}>
          <div className="kv total" style={{ borderTop: "none", margin: 0, padding: 0 }}>
            <span>Net pay</span><span className="mono">{fmt(Math.max(0, slip.basic + slip.allowances - slip.deductions))}</span>
          </div>
        </div>
        <div className="chip-toggle" style={{ marginBottom: 15 }}>
          <div><div className="h-sm">Post to Salaries expenses</div><div className="muted" style={{ fontSize: 12 }}>Flows into accounts &amp; net</div></div>
          <Switch on={slip.postExpense} onToggle={() => setSlip({ ...slip, postExpense: !slip.postExpense })} />
        </div>
        <button
          className="btn"
          onClick={async () => {
            const r = await createPayslip(slip);
            if (!r.ok) return toast(r.error || "Failed", true);
            toast(`Payslip ${"number" in r ? r.number : ""} created`);
            setSheet(null);
            router.refresh();
          }}
        >
          Create payslip
        </button>
      </Sheet>
    </div>
  );
}
