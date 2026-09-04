import { requireStudent } from "@/lib/auth";
import { db } from "@/lib/db";
import { TopBar } from "@/components/chrome";
import { timeAgo } from "@/lib/format";
import { Svg } from "@/components/icons";

export default async function NotificationsPage() {
  const student = await requireStudent();

  const notifications = await db.notification.findMany({
    where: { studentId: student.id },
    orderBy: { at: "desc" },
    take: 50, // a long-tenured student's full notification history has no reason to all render at once
  });

  // Mark all as read (server-side)
  if (notifications.some((n) => !n.read)) {
    await db.notification.updateMany({
      where: { studentId: student.id, read: false },
      data: { read: true },
    });
  }

  return (
    <div className="screen">
      <TopBar title="Notifications" back="/c" />

      <div className="pad">
        {notifications.length > 0 ? (
          <div className="list">
            {notifications.map((n) => (
              <div key={n.id} className="list-item">
                <div
                  className="icon-tile"
                  style={{
                    background: n.kind === "ready" ? "var(--teal-soft)" : "var(--teal-tint)",
                  }}
                >
                  <Svg name={n.kind === "ready" ? "ready" : "bell"} size={20} />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: "14px", lineHeight: 1.4 }}>
                    {n.text}
                  </div>
                  <div className="muted mt4" style={{ fontSize: "12px" }}>
                    {timeAgo(n.at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">
            <Svg name="bell" size={48} />
            <div>No notifications yet</div>
          </div>
        )}
      </div>
    </div>
  );
}
