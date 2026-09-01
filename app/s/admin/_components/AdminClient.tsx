"use client";
/* Admin hub — rates & GST, plan, payment details, colleges + feature flags,
   staff roles, payroll, report settings. All wired to server actions. */
import { useState } from "react";
import { featureOn, type FeatureKey } from "@/lib/features";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { fmt } from "@/lib/format";
import { useToast, Sheet, Switch, Seg } from "@/components/chrome";
import {
  saveRates, savePlan, togglePlan, savePaymentConfig, saveSettings,
  toggleFeature, saveCollege, deleteCollege, setCollegeActive, saveStaff, setStaffActive, createPayslip,
} from "@/lib/actions/admin";
import { markErrorsSeen, syncSheetsNow } from "@/lib/actions/ops";
import { saveSlotWindow, toggleSlotWindow, deleteSlotWindow } from "@/lib/actions/slots";
import { hhmm as slotTime } from "@/lib/slots"; // local `hhmm` below formats a timestamp — don't collide
import { TestOtpPanel } from "@/components/test-otp-panel";
import { WEEKDAY_NAMES, WEEKDAY_SHORT } from "@/lib/washday";

const SERVICE_LABEL: Record<string, string> = { washIron: "Wash & Iron", washFold: "Wash & Fold", ironOnly: "Iron Only", dryClean: "Dry Clean" };
type PlanBucket = { service: string; cycles: number; kgPerCycle: number };
type PlanRow = { id: string; collegeId: string; name: string; price: number; gstFree: boolean; tier: string | null; active: boolean; buckets: PlanBucket[] };

type Rates = Record<string, { label: string; items: [string, number][] }>;
type Props = {
  config: {
    gstPct: number;
    plan: { price: number; cycles: number; kgPerCycle: number };
    rates: Rates;
    payment: { upiId: string; payeeName: string; bankName: string; accountName: string; accountNo: string; ifsc: string; gatewayKey: string };
    settings: { reportEmail?: string; dailyEmail?: boolean; sendHour?: number; openingFloat?: number; gstEnabled?: boolean; garmentTagsEnabled?: boolean };
  };
  colleges: { id: string; name: string; address: string; closedWeekday: number | null; active: boolean; features: Record<string, boolean> }[];
  washDayByCollege: Record<string, number[]>;
  staff: { id: string; name: string; phone: string; role: number; collegeId: string | null; active: boolean }[];
  payslips: { id: string; number: string; month: string; net: number; staffName: string }[];
  plans: PlanRow[];
  attendance: { staffId: string; name: string; todayIn: number | null; todayOut: number | null; daysThisMonth: number }[];
  month: string;
  errors: { id: string; kind: string; message: string; url: string | null; seen: boolean; at: number }[];
  slotWindows: SlotWindowRow[];
  currentRole: number;
};

type SlotWindowRow = { id: string; collegeId: string; weekday: number; startMin: number; endMin: number; capacity: number; active: boolean };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const ROLE_NAMES: Record<number, string> = { 1: "Counter", 2: "Manager", 3: "Admin", 4: "Owner" };
/* Typed as FeatureKey so adding a toggle here without giving it a default in
   lib/features.ts fails the build instead of rendering a switch that resolves
   to nothing. */
const FEATURES: [FeatureKey, string][] = [
  ["svc_wash", "Wash & Iron"], ["svc_washfold", "Wash & Fold"], ["svc_iron", "Iron Only"], ["svc_dryclean", "Dry Clean"],
  ["subscriptions", "Subscriptions"], ["credits", "Credits & compensation"],
  ["express", "Express (same-day)"], ["chat", "Chat & complaints"],
];

export default function StaffAdminClient({ config, colleges, staff, payslips, plans, attendance, month, errors, slotWindows, washDayByCollege, currentRole }: Props) {
  const hhmm = (t: number) => new Date(t).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  const unseenErrors = errors.filter((e) => !e.seen).length;
  const [syncingSheet, setSyncingSheet] = useState(false);
  const router = useRouter();
  const toast = useToast();

  const [sheet, setSheet] = useState<null | "rates" | "plan" | "payment" | "settings" | "college" | "staff" | "payslip" | "slot">(null);
  const [rates, setRates] = useState<Rates>(JSON.parse(JSON.stringify(config.rates)));
  const [gst, setGst] = useState(config.gstPct);
  const [gstOn, setGstOn] = useState(config.settings.gstEnabled !== false);
  const emptyPlan = (collegeId: string): Omit<PlanRow, "active" | "id"> & { id?: string } =>
    ({ id: undefined, collegeId, name: "", price: 0, gstFree: false, tier: null, buckets: [{ service: "washIron", cycles: 34, kgPerCycle: 7 }] });
  const [planEdit, setPlanEdit] = useState<ReturnType<typeof emptyPlan>>(emptyPlan(colleges[0]?.id || ""));
  const [pay, setPay] = useState({ ...config.payment });
  const [settings, setSettings] = useState({ reportEmail: config.settings.reportEmail || "", dailyEmail: !!config.settings.dailyEmail, sendHour: config.settings.sendHour ?? 21, openingFloat: config.settings.openingFloat ?? 0, garmentTagsEnabled: config.settings.garmentTagsEnabled === true });
  const [colEdit, setColEdit] = useState<{ id?: string; name: string; address: string; closedWeekday: number | null }>({ name: "", address: "", closedWeekday: null });
  const [stEdit, setStEdit] = useState<{ id?: string; name: string; phone: string; role: number; active?: boolean }>({ name: "", phone: "", role: 1 });
  const [impCollege, setImpCollege] = useState(colleges.find((c) => c.active)?.id || colleges[0]?.id || "");
  const [impBusy, setImpBusy] = useState(false);
  const [impResult, setImpResult] = useState<null | { added: string[]; skipped: string[]; problems: string[]; warnings: string[] }>(null);
  const [slip, setSlip] = useState({ staffId: staff[0]?.id || "", month: new Date().toISOString().slice(0, 7), basic: 0, allowances: 0, deductions: 0, postExpense: true });
  const emptySlot = (collegeId: string) => ({ id: undefined as string | undefined, collegeId, weekday: 1, startMin: 540, endMin: 660, capacity: 15 });
  const [slotEdit, setSlotEdit] = useState<ReturnType<typeof emptySlot>>(emptySlot(colleges[0]?.id || ""));

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
  const setRateItem = (svc: string, i: number, name: string, price: number) => {
    setRates((r) => {
      const items = r[svc].items.map((it, j) => (j === i ? ([name, price] as [string, number]) : it));
      return { ...r, [svc]: { ...r[svc], items } };
    });
  };
  const addRateItem = (svc: string) => {
    setRates((r) => ({ ...r, [svc]: { ...r[svc], items: [...r[svc].items, ["New item", 0] as [string, number]] } }));
  };
  const removeRateItem = (svc: string, i: number) => {
    setRates((r) => ({ ...r, [svc]: { ...r[svc], items: r[svc].items.filter((_, j) => j !== i) } }));
  };

  return (
    <div className="pad">
      {currentRole >= 4 && <TestOtpPanel />}
      {currentRole >= 4 && errors.length > 0 && (
        <>
          <div className="between" style={{ padding: "0 4px 10px" }}>
            <span className="sec-title" style={{ padding: 0, color: unseenErrors ? "var(--red)" : undefined }}>
              App errors {unseenErrors ? `· ${unseenErrors} new` : ""}
            </span>
            <button className="btn xs sec" onClick={async () => { await markErrorsSeen(); toast("Marked reviewed"); router.refresh(); }}>Mark reviewed</button>
          </div>
          <div className="card pad">
            {errors.slice(0, 8).map((e) => (
              <div key={e.id} className="kv" style={{ alignItems: "flex-start" }}>
                <span className="k" style={{ fontSize: 12.5 }}>
                  <span style={{ fontWeight: 600, color: e.seen ? "var(--muted)" : "var(--red)" }}>{e.message.slice(0, 70)}</span>
                  <span className="muted" style={{ display: "block", fontSize: 11 }}>{e.kind} · {e.url?.replace(/^https?:\/\/[^/]+/, "") || "?"} · {new Date(e.at).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="sec-title mt16">Settings</div>

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

      {currentRole >= 4 && (
        <button
          className="card-btn mt8"
          disabled={syncingSheet}
          onClick={async () => {
            setSyncingSheet(true);
            const r = await syncSheetsNow();
            setSyncingSheet(false);
            toast(r.ok ? "Google Sheet updated" : (r.error || "Sheet not configured"), !r.ok);
          }}
        >
          <div className="icon-tile" style={{ background: "var(--teal-soft)", color: "var(--teal-dark)" }}><Svg name="list" size={20} /></div>
          <div className="grow"><div className="h-sm">{syncingSheet ? "Syncing…" : "Sync to Google Sheet"}</div><div className="muted" style={{ fontSize: 12 }}>Business figures only · also auto-syncs daily at 9pm IST</div></div>
          <Svg name="chevR" size={18} />
        </button>
      )}

      {/* Colleges + feature flags */}
      <div className="sec-title mt20">Colleges &amp; features</div>
      {colleges.map((c) => (
        /* Removed campuses stay listed, dimmed. Hiding them is what made
           removal irreversible: the only screen that can restore one was also
           the screen that stopped showing it. */
        <div key={c.id} className="card pad mt10" style={{ opacity: c.active ? 1 : 0.5 }}>
          <div className="between">
            <div>
              <div className="h-sm">
                {c.name} {!c.active && <span className="pill red" style={{ marginLeft: 6 }}>Removed</span>}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {c.address}{c.closedWeekday !== null ? ` · ${WEEKDAY_NAMES[c.closedWeekday]}s closed` : ""}
              </div>
            </div>
            <div className="row gap6">
              <a className="btn xs sec" href={`/api/export/college-statement?collegeId=${c.id}&m=${month}`} target="_blank">Statement</a>
              {currentRole >= 4 && (
                <>
                  <button className="btn xs sec" onClick={() => { setColEdit({ id: c.id, name: c.name, address: c.address, closedWeekday: c.closedWeekday }); setSheet("college"); }}><Svg name="edit" size={13} /></button>
                  {c.active ? (
                    colleges.filter((x) => x.active).length > 1 && (
                      <button className="btn xs sec" style={{ color: "var(--red)" }} onClick={() => { if (confirm(`Remove ${c.name}?

Students already registered there keep their records and can be restored with the campus.`)) run(() => deleteCollege(c.id), "College removed"); }}><Svg name="trash" size={13} /></button>
                    )
                  ) : (
                    <button className="btn xs sec" onClick={() => run(() => setCollegeActive(c.id, true), "Campus restored")}>Restore</button>
                  )}
                </>
              )}
            </div>
          </div>
          <div className="divider" />
          {FEATURES.map(([key, label]) => (
            <div key={key} className="between" style={{ padding: "7px 0" }}>
              <span style={{ fontSize: 14 }}>{label}</span>
              <Switch
                /* Same reading the student app uses, so this switch shows what
                   is actually on at that campus. `!== false` drew a missing
                   flag as enabled even for express, which defaults off. */
                on={featureOn(c.features, key as FeatureKey)}
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
        <button className="btn ghost mt12" onClick={() => { setColEdit({ name: "", address: "", closedWeekday: null }); setSheet("college"); }}>
          <Svg name="plus" size={17} /> Add college
        </button>
      )}

      {/* Wash-day spread chart removed — rota parked (Sep 2026). */}

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
              <button style={{ textAlign: "left", flex: 1 }} onClick={() => { setPlanEdit({ id: p.id, collegeId: p.collegeId, name: p.name, price: p.price, gstFree: p.gstFree, tier: p.tier, buckets: JSON.parse(JSON.stringify(p.buckets)) }); setSheet("plan"); }}>
                <div className="h-sm" style={{ opacity: p.active ? 1 : 0.45 }}>
                  {p.name} · {fmt(p.price)}
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

      {/* Drop-off slot windows per college */}
      <div className="sec-title mt20">Drop-off slots</div>
      {colleges.map((c) => (
        <div key={c.id} className="card pad mt10">
          <div className="between">
            <div className="h-sm">{c.name}</div>
            <button className="btn xs" onClick={() => { setSlotEdit(emptySlot(c.id)); setSheet("slot"); }}>
              <Svg name="plus" size={13} /> Add window
            </button>
          </div>
          {slotWindows.filter((w) => w.collegeId === c.id).length === 0 && (
            <div className="muted mt8" style={{ fontSize: "12.5px" }}>
              No windows — students here just drop in any time (no slot picker shown).
            </div>
          )}
          {slotWindows.filter((w) => w.collegeId === c.id).map((w) => (
            <div key={w.id} className="between mt10" style={{ alignItems: "flex-start" }}>
              <button
                style={{ textAlign: "left", flex: 1 }}
                onClick={() => { setSlotEdit({ id: w.id, collegeId: w.collegeId, weekday: w.weekday, startMin: w.startMin, endMin: w.endMin, capacity: w.capacity }); setSheet("slot"); }}
              >
                <div className="h-sm" style={{ opacity: w.active ? 1 : 0.45 }}>
                  {WEEKDAYS[w.weekday]} · {slotTime(w.startMin)}–{slotTime(w.endMin)}
                </div>
                <div className="muted" style={{ fontSize: "12px", opacity: w.active ? 1 : 0.45 }}>
                  up to {w.capacity} orders
                </div>
              </button>
              <Switch on={w.active} onToggle={async () => { const r = await toggleSlotWindow(w.id); if (!r.ok) return toast("Failed", true); toast(`Window ${r.active ? "enabled" : "disabled"}`); router.refresh(); }} />
            </div>
          ))}
        </div>
      ))}

      {/* Import students from the enrolment sheet */}
      <div className="sec-title mt20">Import students</div>
      <div className="card pad mt10">
        <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
          Upload the enrolment .xlsx — columns <b>Name</b>, <b>Mobile</b>, <b>Customer ID</b> (B1001 / S1009 / G1100), Amount optional.
          Already-registered mobiles are skipped, never overwritten, so re-uploading the same sheet is safe.
        </div>
        <div className="field mt10">
          <label>Campus</label>
          <select className="input" value={impCollege} onChange={(e) => setImpCollege(e.target.value)}>
            {colleges.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <input
          type="file"
          accept=".xlsx"
          className="input mt10"
          disabled={impBusy}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = ""; // same file can be re-picked after fixing it
            if (!f) return;
            setImpBusy(true); setImpResult(null);
            const fd = new FormData();
            fd.append("file", f);
            fd.append("collegeId", impCollege);
            try {
              const res = await fetch("/api/import/students", { method: "POST", body: fd });
              const j = await res.json();
              if (!j.ok) { toast(j.error || "Import failed", true); return; }
              setImpResult(j);
              toast(`${j.added.length} imported · ${j.skipped.length} skipped · ${j.problems.length} problems`, j.added.length === 0);
              router.refresh();
            } catch {
              toast("Upload failed — check the connection and try again", true);
            } finally {
              setImpBusy(false);
            }
          }}
        />
        {impBusy && <div className="muted mt8" style={{ fontSize: 13 }}>Importing — leave this page open…</div>}
        {impResult && (
          <div className="mt10" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
            <div><b>{impResult.added.length} added</b>{impResult.added.length > 0 && `: ${impResult.added.slice(0, 5).join(", ")}${impResult.added.length > 5 ? "…" : ""}`}</div>
            {impResult.skipped.length > 0 && <div className="muted">{impResult.skipped.length} already registered (skipped)</div>}
            {impResult.warnings.map((w) => <div key={w} style={{ color: "var(--amber)" }}>{w}</div>)}
            {impResult.problems.map((x) => <div key={x} style={{ color: "var(--danger, #c0392b)" }}>{x}</div>)}
          </div>
        )}
      </div>

      {/* Staff */}
      <div className="sec-title mt20">Staff roles</div>
      <div className="list">
        {staff.map((x) => (
          /* Removed staff stay listed, dimmed. Hiding them would make it look
             as though the account never existed, when their name is still on
             past payslips and payments — and you need a way back if the wrong
             person was removed. */
          <button key={x.id} className="list-item tap" style={{ width: "100%", textAlign: "left", opacity: x.active ? 1 : 0.45 }}
            onClick={() => { setStEdit({ id: x.id, name: x.name, phone: x.phone, role: x.role, active: x.active }); setSheet("staff"); }}>
            <div className="avatar" style={{ width: 38, height: 38, fontSize: 14 }}>{x.name[0]}</div>
            <div className="grow">
              <div className="h-sm">{x.name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{x.phone}</div>
            </div>
            <span className={x.active ? "pill gray" : "pill red"}>{x.active ? ROLE_NAMES[x.role] : "Removed"}</span>
          </button>
        ))}
      </div>
      <button className="btn ghost mt12" onClick={() => { setStEdit({ name: "", phone: "", role: 1 }); setSheet("staff"); }}>
        <Svg name="plus" size={17} /> Add staff
      </button>

      {/* Attendance */}
      <div className="sec-title mt20">Attendance · {month}</div>
      <div className="list">
        {attendance.map((a) => (
          <div key={a.staffId} className="list-item">
            <div className="grow">
              <div className="h-sm">{a.name}</div>
              <div className="muted" style={{ fontSize: 12 }}>
                {a.todayIn ? `Today: in ${hhmm(a.todayIn)}${a.todayOut ? ` · out ${hhmm(a.todayOut)}` : " · on shift"}` : "Not in today"}
              </div>
            </div>
            <span className="pill gray">{a.daysThisMonth} day{a.daysThisMonth === 1 ? "" : "s"}</span>
          </div>
        ))}
      </div>

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
        {/* Items are editable in full — name, price, add, remove. The menu is
            the owner's to change (the Sep 2026 dry-clean list came in this
            way); wash services bill by the CYCLE now, so their item lists are
            legacy and hidden from editing to avoid implying they still bill. */}
        {Object.entries(rates).map(([svc, r]) => (
          <div key={svc} className="card pad" style={{ marginBottom: 12 }}>
            <div className="h-sm" style={{ marginBottom: 8 }}>
              {r.label}
              {(svc === "washFold" || svc === "washIron") && (
                <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}> — billed per cycle ({svc === "washFold" ? "₹200" : "₹250"}), items below are legacy</span>
              )}
            </div>
            {(svc === "washFold" || svc === "washIron") ? null : r.items.map(([name, price], i) => (
              <div key={i} className="row gap8" style={{ padding: "5px 0", alignItems: "center" }}>
                <input className="input" value={name} style={{ flex: 1, height: 38 }} onChange={(e) => setRateItem(svc, i, e.target.value, price)} />
                <input className="input" type="number" value={price} style={{ width: 90, height: 38, textAlign: "right" }} onChange={(e) => setRateItem(svc, i, name, Number(e.target.value))} />
                <button className="btn xs sec" onClick={() => removeRateItem(svc, i)} aria-label={`Remove ${name}`}>×</button>
              </div>
            ))}
            {!(svc === "washFold" || svc === "washIron") && (
              <button className="btn xs ghost mt8" onClick={() => addRateItem(svc)}>+ Add item</button>
            )}
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
        <div className="field">
          <label>Tier</label>
          <select className="input" style={{ height: 42 }} value={planEdit.tier || ""} onChange={(e) => setPlanEdit({ ...planEdit, tier: e.target.value || null })}>
            <option value="">No tier (bag code W###)</option>
            <option value="bronze">Bronze — bag code B###</option>
            <option value="silver">Silver — bag code S###</option>
            <option value="gold">Gold — bag code G###</option>
          </select>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            Sets the letter printed on the bags of students on this plan. Changing it does not
            re-letter bags already handed out — those codes stay as issued.
          </div>
        </div>
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
        {/* Per-garment QR tagging toggle removed (owner, Sep 2026) — the
            backend flag still exists but stays off; restore from git if wanted. */}
        <button className="btn" onClick={() => run(() => saveSettings(settings), "Settings saved")}>Save settings</button>
      </Sheet>

      <Sheet open={sheet === "college"} onClose={() => setSheet(null)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>{colEdit.id ? "Edit college" : "Add college"}</div>
        <div className="field"><label>Name</label><input className="input" value={colEdit.name} onChange={(e) => setColEdit({ ...colEdit, name: e.target.value })} /></div>
        <div className="field"><label>Address</label><input className="input" value={colEdit.address} onChange={(e) => setColEdit({ ...colEdit, address: e.target.value })} /></div>
        <div className="field">
          <label>Weekly holiday (closed)</label>
          <select
            className="input"
            value={colEdit.closedWeekday === null ? "" : colEdit.closedWeekday}
            onChange={(e) => setColEdit({ ...colEdit, closedWeekday: e.target.value === "" ? null : Number(e.target.value) })}
          >
            <option value="">None</option>
            {WEEKDAY_NAMES.map((n, i) => <option key={i} value={i}>{n}</option>)}
          </select>
        </div>
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

        {/* Removal is a separate, explicit action — never a side effect of Save.
            It ends their session immediately and blocks new sign-ins, but keeps
            their payslips and the audit trail of payments they took. */}
        {stEdit.id && (
          stEdit.active === false ? (
            <button
              className="btn sec mt12"
              onClick={() => run(() => setStaffActive(stEdit.id!, true), "Staff login restored")}
            >
              Restore this login
            </button>
          ) : (
            <button
              className="btn sec mt12"
              style={{ color: "var(--red)" }}
              onClick={() => {
                if (!confirm(`Remove ${stEdit.name}'s login?\n\nThey can no longer sign in with ${stEdit.phone}, and any device they are signed in on loses access immediately. Payslips and past records are kept.`)) return;
                run(() => setStaffActive(stEdit.id!, false), "Staff login removed");
              }}
            >
              Remove this login
            </button>
          )
        )}
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

      {/* Drop-off window sheet */}
      <Sheet open={sheet === "slot"} onClose={() => setSheet(null)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>{slotEdit.id ? "Edit" : "Add"} drop-off window</div>
        <div className="field">
          <label>Day</label>
          <select className="input" value={slotEdit.weekday} onChange={(e) => setSlotEdit({ ...slotEdit, weekday: Number(e.target.value) })}>
            {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
          </select>
        </div>
        <div className="row gap8">
          <div className="field" style={{ flex: 1 }}>
            <label>Starts</label>
            <input
              className="input" type="time" step={900}
              value={`${String(Math.floor(slotEdit.startMin / 60)).padStart(2, "0")}:${String(slotEdit.startMin % 60).padStart(2, "0")}`}
              onChange={(e) => { const [h, m] = e.target.value.split(":").map(Number); setSlotEdit({ ...slotEdit, startMin: h * 60 + m }); }}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Ends</label>
            <input
              className="input" type="time" step={900}
              value={`${String(Math.floor(slotEdit.endMin / 60)).padStart(2, "0")}:${String(slotEdit.endMin % 60).padStart(2, "0")}`}
              onChange={(e) => { const [h, m] = e.target.value.split(":").map(Number); setSlotEdit({ ...slotEdit, endMin: h * 60 + m }); }}
            />
          </div>
        </div>
        <div className="field">
          <label>Capacity — max orders in this window</label>
          <input className="input" type="number" min={1} max={500} value={slotEdit.capacity} onChange={(e) => setSlotEdit({ ...slotEdit, capacity: Number(e.target.value) })} />
        </div>
        <div className="muted" style={{ fontSize: "12px", padding: "0 4px 12px" }}>
          Once {slotEdit.capacity} orders are booked, students see this window as full and must pick another.
        </div>
        <button className="btn" onClick={() => run(() => saveSlotWindow(slotEdit), slotEdit.id ? "Window updated" : "Window added")}>
          {slotEdit.id ? "Save window" : "Add window"}
        </button>
        {slotEdit.id && (
          <button
            className="btn sec mt10"
            style={{ color: "var(--red)", background: "var(--red-soft)", border: "none" }}
            onClick={async () => {
              if (!confirm("Delete this window? Orders already booked into it keep their slot.")) return;
              const r = await deleteSlotWindow(slotEdit.id!);
              if (!r.ok) return toast("Failed", true);
              toast("Window deleted");
              setSheet(null);
              router.refresh();
            }}
          >
            <Svg name="trash" size={16} /> Delete window
          </button>
        )}
      </Sheet>
    </div>
  );
}
