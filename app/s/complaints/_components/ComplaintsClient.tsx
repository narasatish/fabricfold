"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Svg } from "@/components/icons";
import { timeAgo, initials } from "@/lib/format";
import { Seg } from "@/components/chrome";

type Complaint = {
  id: string;
  studentId: string;
  text: string;
  status: string;
  createdAt: Date;
  student: { id: string; name: string };
  messages: Array<{ id: string; text: string; staff: boolean; createdAt: Date }>;
};

export default function StaffComplaintsClient({
  open,
  resolved,
}: {
  open: Complaint[];
  resolved: Complaint[];
}) {
  const router = useRouter();
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");

  const complaints =
    filter === "open" ? open : filter === "resolved" ? resolved : [...open, ...resolved];

  const renderComplaintCard = (c: Complaint) => (
    <button
      key={c.id}
      className="card pad mt10"
      onClick={() => router.push(`/s/complaints/${c.id}`)}
      style={{ width: "100%", textAlign: "left" }}
    >
      <div className="row gap12" style={{ marginBottom: "12px" }}>
        <div className="avatar">{initials(c.student.name)}</div>
        <div style={{ flex: 1 }}>
          <div className="h-sm">{c.student.name}</div>
          <div className="muted" style={{ fontSize: "12px" }}>{timeAgo(c.createdAt)}</div>
        </div>
      </div>
      <div className="muted" style={{ fontSize: "13px", lineHeight: "1.5" }}>
        {c.text}
      </div>
      {c.messages.length > 0 && (
        <div className="muted" style={{ fontSize: "12px", marginTop: "8px" }}>
          {c.messages.length} message{c.messages.length > 1 ? "s" : ""}
        </div>
      )}
    </button>
  );

  return (
    <div className="pad">
      <Seg<"open" | "resolved" | "all">
        options={[
          ["open", `Open${open.length ? ` ${open.length}` : ""}`],
          ["resolved", `Resolved`],
          ["all", "All"],
        ]}
        value={filter}
        onChange={setFilter}
      />

      {complaints.length ? (
        complaints.map(renderComplaintCard)
      ) : (
        <div className="card pad center muted" style={{ padding: "24px", marginTop: "16px" }}>
          No complaints
        </div>
      )}
    </div>
  );
}
