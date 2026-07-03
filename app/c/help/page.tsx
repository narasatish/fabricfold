import { requireStudent } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import { timeAgo, dateStr } from "@/lib/format";
import { Svg } from "@/components/icons";
import HelpClient from "./_components/HelpClient";

export default async function HelpPage() {
  const student = await requireStudent();

  const complaints = await db.complaint.findMany({
    where: { studentId: student.id },
    orderBy: { at: "desc" },
    include: { messages: { orderBy: { at: "asc" } } },
  });

  return (
    <div className="screen">
      <TopBar title="Help" back="/c/profile" />

      <div className="pad">
        {/* WhatsApp card */}
        <a
          href="https://wa.me/918019121966"
          target="_blank"
          rel="noreferrer"
          className="card-btn"
          style={{ background: "#25D366", color: "#fff", border: "none", marginBottom: "20px" }}
        >
          <div className="icon-tile" style={{ background: "rgba(255,255,255,.2)", color: "#fff" }}>
            <Svg name="chat" size={22} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="h-sm" style={{ color: "#fff" }}>
              Chat with us on WhatsApp
            </div>
            <div style={{ fontSize: "12.5px", color: "rgba(255,255,255,.85)" }}>
              Replies via our AI assistant + team
            </div>
          </div>
          <Svg name="chevR" size={18} />
        </a>

        {/* Complaint form */}
        <div className="sec-title">Raise a complaint</div>
        <HelpClient orderId={undefined} />

        {/* My complaints */}
        {complaints.length > 0 && (
          <>
            <div className="sec-title mt20">Your complaints</div>
            {complaints.map((c) => (
              <div key={c.id} className="card pad mt10">
                <div className="between">
                  <span className={`pill ${c.status === "open" ? "amber" : ""}`}>
                    {c.status === "open" ? "Open" : "Resolved"}
                  </span>
                  <span className="muted" style={{ fontSize: "12px" }}>
                    {timeAgo(c.at)}
                  </span>
                </div>
                <div className="mt8" style={{ fontSize: "14px" }}>
                  {c.text}
                </div>

                {/* Chat messages */}
                {c.messages && c.messages.length > 0 && (
                  <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid var(--line)" }}>
                    {c.messages.map((m: any) => (
                      <div key={m.id} style={{ marginBottom: "8px" }}>
                        <div style={{ fontSize: "11px", color: "var(--muted)", marginBottom: "2px" }}>
                          {m.role === "student" ? "You" : "Staff"} · {dateStr(m.at)}
                        </div>
                        <div
                          style={{
                            background: m.role === "student" ? "var(--teal-soft)" : "var(--line)",
                            padding: "8px 12px",
                            borderRadius: "8px",
                            fontSize: "13px",
                          }}
                        >
                          {m.text}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
