import { requireStudent } from "@/lib/auth";
import { TopBar } from "@/components/chrome";
import { fmt, initials, loyaltyBadge } from "@/lib/format";
import { Svg } from "@/components/icons";
import Link from "next/link";
import ProfileClient from "./_components/ProfileClient";

export default async function ProfilePage() {
  const student = await requireStudent();
  const college = student.college;
  const tier = loyaltyBadge(student.lifetimePieces);

  return (
    <div className="screen">
      <TopBar title="Profile" />

      <div className="pad">
        <div className="card pad row gap16">
          <div className="avatar" style={{ width: "56px", height: "56px", fontSize: "20px" }}>
            {initials(student.name)}
          </div>
          <div style={{ flex: 1 }}>
            <div className="h-md">{student.name}</div>
            <div className="muted" style={{ fontSize: "13px" }}>
              +91 {student.phone}
            </div>
            <div className="row gap8 mt8" style={{ flexWrap: "wrap" }}>
              <span className="pill">ID {student.id}</span>
              <span className="pill" style={{ background: tier.bg, color: tier.fg }}>
                {tier.name} member
              </span>
            </div>
          </div>
        </div>

        <div className="list mt16">
          <div className="list-item">
            <span style={{ color: "var(--teal)" }}>
              <Svg name="building" size={20} />
            </span>
            <div style={{ flex: 1 }}>
              <div className="h-sm">Campus</div>
              <div className="muted" style={{ fontSize: "12.5px" }}>
                {college?.name}
              </div>
            </div>
          </div>

          <ProfileClient studentName={student.name} />

          <Link href="/c/notifications" className="list-item tap" style={{ width: "100%", textAlign: "left", textDecoration: "none" }}>
            <span style={{ color: "var(--teal)" }}>
              <Svg name="bell" size={20} />
            </span>
            <div style={{ flex: 1 }}>
              <div className="h-sm">Notifications</div>
              <div className="muted" style={{ fontSize: "12px" }}>
                Choose how you're alerted
              </div>
            </div>
            <Svg name="chevR" size={18} />
          </Link>

          <Link href="/c/help" className="list-item tap" style={{ width: "100%", textAlign: "left", textDecoration: "none" }}>
            <span style={{ color: "var(--teal)" }}>
              <Svg name="chat" size={20} />
            </span>
            <div style={{ flex: 1 }}>
              <div className="h-sm">Help & complaints</div>
            </div>
            <Svg name="chevR" size={18} />
          </Link>

          <Link href="#" className="list-item tap" style={{ width: "100%", textAlign: "left", textDecoration: "none" }}>
            <span style={{ color: "var(--teal)" }}>
              <Svg name="shield" size={20} />
            </span>
            <div style={{ flex: 1 }}>
              <div className="h-sm">Terms, policies & compensation</div>
            </div>
            <Svg name="chevR" size={18} />
          </Link>

          <div className="list-item">
            <span style={{ color: "var(--teal)" }}>
              <Svg name="settings" size={20} />
            </span>
            <div style={{ flex: 1 }}>
              <div className="h-sm">Dark mode</div>
              <div className="muted" style={{ fontSize: "12px" }}>
                Easier on the eyes at night
              </div>
            </div>
            <div className="switch" onClick={() => (window.location.href = "#")} role="switch" aria-checked="false" />
          </div>
        </div>

        <Link href="/api/auth/logout" className="btn sec mt16">
          <Svg name="logout" size={18} /> Log out
        </Link>

        <div className="center muted mt16" style={{ fontSize: "11px" }}>
          FabricFold · customer app v1
        </div>
      </div>
    </div>
  );
}
