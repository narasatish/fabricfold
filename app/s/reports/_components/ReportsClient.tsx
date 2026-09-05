"use client";
/* Reports controls: period picker (URL-driven), expense sheet, email button. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { Seg, Sheet, useToast } from "@/components/chrome";
import { submitExpense } from "@/lib/actions/admin";
import { closeDay } from "@/lib/actions/ops";
import { fmt } from "@/lib/format";

export default function ReportsControls({
  period, d, m, y, colleges, collegeId,
}: {
  period: "day" | "week" | "month" | "year" | "all"; d?: string; m?: string; y?: string;
  /** Only non-empty for an Owner (collegeId null) — a campus-scoped staffer
      never gets a choice, computeReport already forces their own campus. */
  colleges?: { id: string; name: string }[];
  collegeId?: string; // "all" or a real college id
}) {
  const router = useRouter();
  /* toISOString() is UTC and getFullYear() is the DEVICE's timezone — near
     midnight IST either can pre-fill the picker with the wrong calendar day,
     which then goes straight to the server as ?d=/?m=/?y= and is taken at
     face value. Compute the IST day explicitly instead, same shift the
     server uses. */
  const istNow = new Date(Date.now() + 5.5 * 3600_000);
  const today = istNow.toISOString().slice(0, 10);
  const thisMonth = istNow.toISOString().slice(0, 7);
  const thisYear = today.slice(0, 4);
  const cParam: Record<string, string> = collegeId && collegeId !== "all" ? { c: collegeId } : {};

  const nav = (p: string, extra?: Record<string, string>) => {
    const params = new URLSearchParams({ p, ...cParam, ...(extra || {}) });
    router.push(`/s/reports?${params.toString()}`);
  };
  const navCollege = (c: string) => {
    const params = new URLSearchParams({
      p: period, ...(d ? { d } : {}), ...(m ? { m } : {}), ...(y ? { y } : {}),
      ...(c !== "all" ? { c } : {}),
    });
    router.push(`/s/reports?${params.toString()}`);
  };

  return (
    <>
      {colleges && colleges.length > 1 && (
        <div className="seg" style={{ marginBottom: 10 }}>
          <button className={!collegeId || collegeId === "all" ? "active" : ""} onClick={() => navCollege("all")}>All</button>
          {colleges.map((c) => (
            <button key={c.id} className={collegeId === c.id ? "active" : ""} onClick={() => navCollege(c.id)}>{c.name}</button>
          ))}
        </div>
      )}
      <Seg<"day" | "week" | "month" | "year" | "all">
        options={[["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["all", "All"]]}
        value={period}
        onChange={(p) => nav(p, p === "day" || p === "week" ? { d: d || today } : p === "month" ? { m: m || thisMonth } : p === "year" ? { y: y || thisYear } : {})}
      />
      {(period === "day" || period === "week") && (
        <input className="input mt10" type="date" value={d || today} onChange={(e) => nav(period, { d: e.target.value })} />
      )}
      {period === "month" && (
        <input className="input mt10" type="month" value={m || thisMonth} onChange={(e) => nav("month", { m: e.target.value })} />
      )}
      {period === "year" && (
        <input className="input mt10" type="number" defaultValue={y || thisYear} onBlur={(e) => nav("year", { y: e.target.value })} />
      )}
    </>
  );
}

/* Day-close ritual: count the physical drawer, record counted vs expected.
   Variance is stored permanently and emailed to the owner. Manager+. */
export function CloseDayButton({ expected, closed, variance }: { expected: number; closed: boolean; variance?: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [counted, setCounted] = useState<number>(0);
  const [touched, setTouched] = useState(false); // so a genuine ₹0 count is possible
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  if (closed) {
    const v = variance ?? 0;
    return (
      <span className={`pill ${v === 0 ? "" : "red"}`}>
        {v === 0 ? "Day closed · drawer matches" : `Day closed · variance ₹${v}`}
      </span>
    );
  }

  const doClose = async () => {
    setBusy(true);
    try {
      const r = await closeDay(counted, note);
      if (!r.ok) return toast(r.error || "Failed", true);
      toast(r.variance === 0 ? "Day closed — drawer matches ✓" : `Day closed — variance ₹${r.variance}`, r.variance !== 0);
      setOpen(false);
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", true);
    } finally {
      setBusy(false);
    }
  };

  const diff = Math.round((counted - expected) * 100) / 100;
  return (
    <>
      <button className="btn xs" onClick={() => { setCounted(0); setTouched(false); setNote(""); setOpen(true); }}>Close day</button>
      <Sheet open={open} onClose={() => setOpen(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>Close the day</h2>
          <p className="muted" style={{ fontSize: "13px", marginBottom: "14px" }}>
            Count the physical cash in the drawer. The result is recorded permanently and emailed to the owner.
          </p>
          <div className="card pad" style={{ background: "var(--teal-tint)", marginBottom: "14px" }}>
            <div className="kv"><span className="k">Expected in drawer</span><span className="mono">{fmt(expected)}</span></div>
          </div>
          <div className="field">
            <label>Counted cash (₹)</label>
            <input className="input" type="number" inputMode="numeric" value={touched ? counted : ""} onChange={(e) => { setTouched(true); setCounted(Number(e.target.value)); }} />
          </div>
          {touched && (
            <div className={`card pad`} style={{ background: diff === 0 ? "var(--teal-tint)" : "var(--red-soft)", marginBottom: "12px" }}>
              <div className="kv total"><span>Variance</span><span className="mono" style={{ color: diff === 0 ? "var(--teal-dark)" : "var(--red)" }}>{diff === 0 ? "₹0 — matches" : `₹${diff}`}</span></div>
            </div>
          )}
          <div className="field">
            <label>Note (required if variance)</label>
            <input className="input" placeholder="e.g. ₹50 short — change error" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <button className="btn" onClick={doClose} disabled={busy || !touched || counted < 0 || (diff !== 0 && !note.trim())}>
            {busy ? "Closing…" : "Confirm & close the day"}
          </button>
        </div>
      </Sheet>
    </>
  );
}

export function ExpenseButton() {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [ex, setEx] = useState({ category: "Supplies", amount: 0, note: "", method: "cash" as "cash" | "upi" });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!ex.amount || ex.amount <= 0) return toast("Enter a valid amount", true);
    setBusy(true);
    try {
      let receiptKey: string | null = null, receiptMime: string | null = null;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/upload/receipt", { method: "POST", body: fd });
        if (!res.ok) return toast("Receipt upload failed: " + (await res.text()), true);
        const j = await res.json();
        receiptKey = j.key; receiptMime = j.mime;
      }
      const r = await submitExpense({ ...ex, receiptKey, receiptMime });
      if (!r.ok) return toast(r.error || "Failed", true);
      toast("Expense logged" + (receiptKey ? " · invoice stored" : ""));
      setOpen(false);
      setEx({ category: "Supplies", amount: 0, note: "", method: "cash" });
      setFile(null);
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed", true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button className="btn xs" onClick={() => setOpen(true)}><Svg name="plus" size={14} /> Log expense</button>
      <Sheet open={open} onClose={() => setOpen(false)}>
        <div className="h-md" style={{ padding: "0 4px 4px" }}>Log an expense</div>
        <div className="muted" style={{ padding: "0 4px 14px", fontSize: 13 }}>Recorded against today for net reporting.</div>
        <div className="field">
          <label>Category</label>
          <select className="input" value={ex.category} onChange={(e) => setEx({ ...ex, category: e.target.value })}>
            {["Supplies", "Utilities", "Rent", "Salaries", "Maintenance", "Other"].map((c) => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Amount (₹)</label>
          <input className="input" inputMode="numeric" type="number" placeholder="e.g. 800" value={ex.amount || ""} onChange={(e) => setEx({ ...ex, amount: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label>Paid by</label>
          <Seg<"cash" | "upi"> options={[["cash", "Cash"], ["upi", "UPI / Bank"]]} value={ex.method} onChange={(mm) => setEx({ ...ex, method: mm })} />
        </div>
        <div className="field">
          <label>Note</label>
          <input className="input" placeholder="Optional" value={ex.note} onChange={(e) => setEx({ ...ex, note: e.target.value })} />
        </div>
        <div className="field">
          <label>Invoice / receipt (photo or PDF — stored with the expense)</label>
          <input className="input" type="file" accept="image/*,.pdf" style={{ paddingTop: 12 }} onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </div>
        <button className="btn" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save expense"}</button>
      </Sheet>
    </>
  );
}

export function EmailReportButton() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/report/daily", { method: "POST" });
      if (res.ok) {
        const j = await res.json();
        toast("Report sent to " + j.to);
      } else toast("Could not send (" + res.status + ")", true);
    } catch {
      toast("Could not send — queued for retry", true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn xs sec" disabled={busy} onClick={send}>
      <Svg name="bell" size={14} /> {busy ? "Sending…" : "Email today's report"}
    </button>
  );
}
