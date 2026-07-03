"use client";
import { timeAgo } from "@/lib/format";

type AuditLog = {
  id: string;
  action: string;
  detail: string;
  at: Date;
  by: string;
};

export default function StaffAuditClient({ logs }: { logs: AuditLog[] }) {
  return (
    <div className="pad">
      {logs.length ? (
        <div className="list">
          {logs.map((log) => (
            <div key={log.id} className="list-item">
              <div style={{ flex: 1 }}>
                <div className="h-sm" style={{ fontWeight: "700" }}>
                  {log.action}
                </div>
                <div className="muted" style={{ fontSize: "13px", marginTop: "4px" }}>
                  {log.detail}
                </div>
                <div className="faint" style={{ fontSize: "11.5px", marginTop: "6px" }}>
                  {log.by} · {timeAgo(log.at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="card pad center muted" style={{ padding: "24px", marginTop: "16px" }}>
          No audit logs
        </div>
      )}
    </div>
  );
}
