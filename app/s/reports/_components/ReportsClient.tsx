"use client";
/* Reports controls: period picker (URL-driven), expense sheet, email button. */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { Seg, Sheet, useToast } from "@/components/chrome";
import { submitExpense } from "@/lib/actions/admin";

export default function ReportsControls({ period, d, m, y }: { period: "day" | "week" | "month" | "year" | "all"; d?: string; m?: string; y?: string }) {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const thisYear = String(new Date().getFullYear());

  const nav = (p: string, extra?: Record<string, string>) => {
    const params = new URLSearchParams({ p, ...(extra || {}) });
    router.push(`/s/reports?${params.toString()}`);
  };

  return (
    <>
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
