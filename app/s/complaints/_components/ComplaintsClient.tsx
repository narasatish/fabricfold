"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { timeAgo, initials } from "@/lib/format";
import { Seg, Sheet, useToast } from "@/components/chrome";
import { sendComplaintMessage, resolveComplaint } from "@/lib/actions/complaints";
import { submitCompensation } from "@/lib/actions/credits";

type Complaint = {
  id: string;
  studentId: string;
  orderId: string | null;
  text: string;
  status: string;
  at: number;
  student: { id: string; name: string; college: string };
  messages: Array<{ id: string; from: string; text: string; at: number }>;
};

export default function StaffComplaintsClient({ complaints, staffRole }: { complaints: Complaint[]; staffRole: number }) {
  const router = useRouter();
  const toast = useToast();
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [resolveFor, setResolveFor] = useState<Complaint | null>(null);
  const [resText, setResText] = useState("");
  const [compFor, setCompFor] = useState<Complaint | null>(null);
  const [comp, setComp] = useState({ kind: "goodwill", amount: 0, method: "credit" as "credit" | "cash", comment: "" });

  const list = filter === "all" ? complaints : complaints.filter((c) => c.status === filter);

  const send = async (c: Complaint) => {
    const t = (drafts[c.id] || "").trim();
    if (!t) return toast("Type a message", true);
    const r = await sendComplaintMessage(c.id, t);
    if (!r.ok) return toast(r.error || "Failed", true);
    setDrafts({ ...drafts, [c.id]: "" });
    router.refresh();
  };

  const doResolve = async () => {
    if (!resolveFor) return;
    const r = await resolveComplaint(resolveFor.id, resText);
    if (!r.ok) return toast(r.error || "Failed", true);
    toast("Complaint resolved");
    setResolveFor(null);
    setResText("");
    router.refresh();
  };

  const doComp = async () => {
    if (!compFor) return;
    // Pass the complaint through so the payout is traceable to the grievance
    // that justified it, not just to the student.
    const r = await submitCompensation({ studentId: compFor.studentId, orderId: compFor.orderId, complaintId: compFor.id, kind: comp.kind, amount: comp.amount, method: comp.method, comment: comp.comment });
    if (!r.ok) return toast(r.error || "Failed", true);
    toast("Compensation issued");
    setCompFor(null);
    setComp({ kind: "goodwill", amount: 0, method: "credit", comment: "" });
    router.refresh();
  };

  return (
    <div className="pad">
      <Seg<"open" | "resolved" | "all">
        options={[["open", "Open"], ["resolved", "Resolved"], ["all", "All"]]}
        value={filter}
        onChange={setFilter}
      />

      {list.length ? (
        list.map((c) => (
          <div key={c.id} className="card pad mt10">
            <div className="between">
              <span className={`pill ${c.status === "open" ? "amber" : ""}`}>{c.status === "open" ? "Open" : "Resolved"}</span>
              <span className="muted" style={{ fontSize: "12px" }}>{timeAgo(c.at)}</span>
            </div>
            <div className="row gap8 mt8" style={{ alignItems: "center" }}>
              <div className="avatar" style={{ width: 34, height: 34, fontSize: 13 }}>{initials(c.student.name)}</div>
              <div>
                <button className="h-sm" onClick={() => router.push(`/s/customers/${c.studentId}`)}>{c.student.name}</button>
                <div className="muted" style={{ fontSize: "11.5px" }}>{c.student.college}{c.orderId ? ` · #${c.orderId.slice(-4)}` : ""}</div>
              </div>
            </div>
            <div className="mt10" style={{ fontSize: 14, lineHeight: 1.45 }}>{c.text}</div>

            {/* chat thread */}
            {c.messages.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 7, marginTop: 12 }}>
                {c.messages.map((m) => (
                  <div
                    key={m.id}
                    style={{
                      maxWidth: "82%", padding: "9px 13px", borderRadius: 15, fontSize: 13.5, lineHeight: 1.45,
                      alignSelf: m.from === "staff" ? "flex-end" : "flex-start",
                      background: m.from === "staff" ? "var(--teal)" : "var(--line)",
                      color: m.from === "staff" ? "#fff" : "var(--ink)",
                    }}
                  >
                    {m.text}
                    <div style={{ fontSize: 10.5, opacity: 0.72, marginTop: 3 }}>{m.from} · {timeAgo(m.at)}</div>
                  </div>
                ))}
              </div>
            )}

            {c.status === "open" && (
              <>
                <div className="row gap8 mt10">
                  <input
                    className="input grow"
                    style={{ height: 44 }}
                    placeholder="Type a message…"
                    value={drafts[c.id] || ""}
                    onChange={(e) => setDrafts({ ...drafts, [c.id]: e.target.value })}
                    onKeyDown={(e) => e.key === "Enter" && send(c)}
                  />
                  <button className="btn sm" style={{ width: "auto", height: 44 }} onClick={() => send(c)}>Send</button>
                </div>
                <div className="row gap8 mt12">
                  <button className="btn xs" onClick={() => setResolveFor(c)}><Svg name="check" size={14} /> Resolve</button>
                  <button className="btn xs sec" onClick={() => setCompFor(c)}><Svg name="gift" size={14} /> Compensate</button>
                </div>
              </>
            )}
          </div>
        ))
      ) : (
        <div className="empty"><Svg name="chat" size={48} /><div>No {filter === "all" ? "" : filter} complaints</div></div>
      )}

      {/* Resolve sheet */}
      <Sheet open={!!resolveFor} onClose={() => setResolveFor(null)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>Resolve complaint</div>
        <textarea className="input" placeholder="How was this resolved? (visible to the student)" value={resText} onChange={(e) => setResText(e.target.value)} />
        <button className="btn mt12" onClick={doResolve}>Mark resolved</button>
      </Sheet>

      {/* Compensation sheet */}
      <Sheet open={!!compFor} onClose={() => setCompFor(null)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>Issue compensation</div>
        <div className="field">
          <label>Kind</label>
          <select className="input" value={comp.kind} onChange={(e) => setComp({ ...comp, kind: e.target.value })}>
            <option value="damage">Damage</option><option value="stain">Stain / re-do</option>
            <option value="missing">Missing item</option><option value="goodwill">Goodwill</option>
            <option value="manual">Adjustment</option>
          </select>
        </div>
        <div className="field">
          <label>Amount (₹)</label>
          <input className="input" type="number" value={comp.amount || ""} onChange={(e) => setComp({ ...comp, amount: Number(e.target.value) })} />
        </div>
        <div className="field">
          <label>Method</label>
          <Seg<"credit" | "cash">
            options={staffRole >= 2 ? [["credit", "Store credit"], ["cash", "Cash"]] : [["credit", "Store credit"]]}
            value={comp.method}
            onChange={(m) => setComp({ ...comp, method: m })}
          />
        </div>
        <div className="field">
          <label>Comment</label>
          <input className="input" placeholder="Visible to the student" value={comp.comment} onChange={(e) => setComp({ ...comp, comment: e.target.value })} />
        </div>
        <button className="btn" onClick={doComp}><Svg name="gift" size={16} /> Issue compensation</button>
      </Sheet>
    </div>
  );
}
