"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { Seg, Sheet, useToast } from "@/components/chrome";
import { fmt, initials } from "@/lib/format";
import { bulkRegisterStudents, broadcastNotice } from "@/lib/actions/students";

type Student = { id: string; name: string; phone: string; credits: number; lifetimePieces: number; collegeId: string; subActive: boolean };
type College = { id: string; name: string };

export default function StudentsClient({ students, colleges, staffRole }: { students: Student[]; colleges: College[]; staffRole: number }) {
  const router = useRouter();
  const toast = useToast();
  const colName = (id: string) => colleges.find((c) => c.id === id)?.name || "—";

  const [q, setQ] = useState("");
  const [campus, setCampus] = useState<"all" | string>("all");
  const [sub, setSub] = useState<"all" | "active" | "none">("all");

  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState("");
  const [importCollege, setImportCollege] = useState(colleges[0]?.id || "");
  const [importResult, setImportResult] = useState<null | { created: number; skipped: { line: string; reason: string }[] }>(null);
  const [busy, setBusy] = useState(false);

  const [showCast, setShowCast] = useState(false);
  const [castScope, setCastScope] = useState<"all" | string>("all");
  const [castText, setCastText] = useState("");

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return students.filter((st) => {
      if (campus !== "all" && st.collegeId !== campus) return false;
      if (sub === "active" && !st.subActive) return false;
      if (sub === "none" && st.subActive) return false;
      if (s && !(st.id.includes(s) || st.phone.includes(s) || st.name.toLowerCase().includes(s))) return false;
      return true;
    });
  }, [students, q, campus, sub]);

  const doImport = async () => {
    setBusy(true);
    const r = await bulkRegisterStudents(importText, importCollege);
    setBusy(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    setImportResult({ created: r.created, skipped: r.skipped });
    toast(`${r.created} student${r.created === 1 ? "" : "s"} added`);
    router.refresh();
  };

  const doCast = async () => {
    if (castText.trim().length < 3) return toast("Enter a message", true);
    setBusy(true);
    const r = await broadcastNotice(castScope, castText);
    setBusy(false);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast(`Sent to ${r.sent} student${r.sent === 1 ? "" : "s"}`);
    setShowCast(false);
    setCastText("");
  };

  return (
    <div className="pad">
      {/* Action buttons */}
      <div className="row gap8">
        <button className="btn" onClick={() => { setImportResult(null); setShowImport(true); }}>
          <Svg name="edit" size={17} /> Bulk import
        </button>
        {staffRole >= 2 && (
          <button className="btn ghost" onClick={() => setShowCast(true)}>
            <Svg name="bell" size={17} /> Send notice
          </button>
        )}
      </div>

      {/* Search + filters */}
      <div className="card mt16" style={{ padding: "4px 6px", display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ color: "var(--muted)", paddingLeft: "8px" }}><Svg name="search" size={20} /></span>
        <input className="input" placeholder="Search name / ID / phone" style={{ border: "none", boxShadow: "none", height: "44px" }} value={q} onChange={(e) => setQ(e.target.value)} />
        {q && <button className="action" onClick={() => setQ("")} aria-label="Clear"><Svg name="x" size={18} /></button>}
      </div>

      {colleges.length > 1 && (
        <div className="mt12">
          <Seg<"all" | string>
            options={[["all", "All campuses"], ...colleges.map((c) => [c.id, c.name] as [string, string])]}
            value={campus} onChange={setCampus}
          />
        </div>
      )}
      <div className="mt10">
        <Seg<"all" | "active" | "none">
          options={[["all", "Everyone"], ["active", "Subscribers"], ["none", "No plan"]]}
          value={sub} onChange={setSub}
        />
      </div>

      <div className="between mt16" style={{ padding: "0 4px" }}>
        <span className="sec-title" style={{ padding: 0 }}>Students</span>
        <span className="pill gray">{filtered.length}</span>
      </div>

      {filtered.length ? (
        filtered.map((st) => (
          <button key={st.id} className="card-btn mt10" onClick={() => router.push(`/s/customers/${st.id}`)}>
            <div className="avatar">{initials(st.name)}</div>
            <div className="grow">
              <div className="between">
                <div className="h-sm">{st.name}</div>
                {st.subActive && <span className="pill" style={{ fontSize: "10.5px" }}>Plan</span>}
              </div>
              <div className="muted" style={{ fontSize: "12.5px" }}>ID {st.id} · +91 {st.phone} · {colName(st.collegeId)}</div>
              <div className="muted" style={{ fontSize: "12px" }}>{st.lifetimePieces} pcs · {fmt(st.credits)} credit</div>
            </div>
            <Svg name="chevR" size={18} />
          </button>
        ))
      ) : (
        <div className="card pad center muted mt10" style={{ padding: "28px" }}>
          {students.length ? "No students match" : "No students yet — use Bulk import to add them"}
        </div>
      )}

      {/* Bulk import sheet */}
      <Sheet open={showImport} onClose={() => setShowImport(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>Bulk import students</h2>
          <p className="muted" style={{ fontSize: "13px", marginBottom: "14px" }}>
            One student per line: <b>Name, 98765 43210</b>. Duplicates and existing numbers are skipped automatically.
          </p>
          {colleges.length > 1 && (
            <div className="field">
              <label>Campus</label>
              <select className="input" value={importCollege} onChange={(e) => setImportCollege(e.target.value)}>
                {colleges.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label>Students</label>
            <textarea className="input" style={{ minHeight: "150px" }} placeholder={"Aarav Menon, 9876500011\nDiya Sharma, 9876500022"} value={importText} onChange={(e) => setImportText(e.target.value)} />
          </div>

          {importResult && (
            <div className="card pad" style={{ background: "var(--teal-tint)", marginBottom: "12px" }}>
              <div className="h-sm" style={{ color: "var(--teal-dark)" }}>{importResult.created} added</div>
              {importResult.skipped.length > 0 && (
                <>
                  <div className="muted mt8" style={{ fontSize: "12.5px" }}>{importResult.skipped.length} skipped:</div>
                  {importResult.skipped.slice(0, 8).map((s, i) => (
                    <div key={i} className="muted" style={{ fontSize: "11.5px" }}>• {s.line} — {s.reason}</div>
                  ))}
                </>
              )}
            </div>
          )}

          <button className="btn" onClick={doImport} disabled={busy || !importText.trim() || !importCollege}>
            <Svg name="check" size={18} /> {busy ? "Importing…" : "Import students"}
          </button>
        </div>
      </Sheet>

      {/* Broadcast sheet */}
      <Sheet open={showCast} onClose={() => setShowCast(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "6px" }}>Send a notice</h2>
          <p className="muted" style={{ fontSize: "13px", marginBottom: "14px" }}>
            Every student gets an in-app notification (and a push alert if they&apos;ve enabled them).
          </p>
          <div className="field">
            <label>Send to</label>
            <select className="input" value={castScope} onChange={(e) => setCastScope(e.target.value)}>
              <option value="all">All campuses</option>
              {colleges.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Message</label>
            <textarea className="input" style={{ minHeight: "100px" }} placeholder="e.g. Counter closed this Sunday for Diwali. Back Monday 9am." value={castText} onChange={(e) => setCastText(e.target.value)} maxLength={280} />
          </div>
          <button className="btn" onClick={doCast} disabled={busy || castText.trim().length < 3}>
            <Svg name="bell" size={18} /> {busy ? "Sending…" : "Send notice"}
          </button>
        </div>
      </Sheet>
    </div>
  );
}
