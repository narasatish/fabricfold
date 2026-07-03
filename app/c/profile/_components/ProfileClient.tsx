"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useToast, Sheet, Switch, toggleTheme } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { logout, updateName } from "@/lib/actions/auth";

export default function ProfileClient({ studentName }: { studentName: string }) {
  const router = useRouter();
  const toast = useToast();
  const [showEditName, setShowEditName] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [editName, setEditName] = useState(studentName);
  const [loading, setLoading] = useState(false);
  const [dark, setDark] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.getAttribute("data-theme") === "dark");
  }, []);

  const handleSaveName = async () => {
    setLoading(true);
    const r = await updateName(editName);
    setLoading(false);
    if (!r.ok) {
      toast(r.error || "Failed", true);
      return;
    }
    setShowEditName(false);
    toast("Name updated");
    router.refresh();
  };

  const handleDark = () => {
    toggleTheme();
    setDark((d) => !d);
  };

  const handleLogout = async () => {
    setLoading(true);
    await logout();
    router.push("/login");
  };

  return (
    <>
      <button
        className="list-item tap"
        style={{ width: "100%", textAlign: "left", padding: "15px 18px" }}
        onClick={() => { setEditName(studentName); setShowEditName(true); }}
      >
        <span style={{ color: "var(--teal)" }}>
          <Svg name="edit" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="h-sm">Edit name</div>
        </div>
        <Svg name="chevR" size={18} />
      </button>

      <button
        className="list-item tap"
        style={{ width: "100%", textAlign: "left", padding: "15px 18px" }}
        onClick={() => setShowTerms(true)}
      >
        <span style={{ color: "var(--teal)" }}>
          <Svg name="shield" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="h-sm">Terms, policies & compensation</div>
        </div>
        <Svg name="chevR" size={18} />
      </button>

      <div className="list-item">
        <span style={{ color: "var(--teal)" }}>
          <Svg name="settings" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="h-sm">Dark mode</div>
          <div className="muted" style={{ fontSize: "12px" }}>Easier on the eyes at night</div>
        </div>
        <Switch on={dark} onToggle={handleDark} />
      </div>

      <button className="list-item tap" style={{ width: "100%", textAlign: "left", padding: "15px 18px", color: "var(--red)" }} onClick={handleLogout} disabled={loading}>
        <Svg name="logout" size={20} />
        <div style={{ flex: 1 }}>
          <div className="h-sm" style={{ color: "var(--red)" }}>{loading ? "Logging out…" : "Log out"}</div>
        </div>
      </button>

      {/* Edit name sheet */}
      <Sheet open={showEditName} onClose={() => setShowEditName(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "16px" }}>Edit name</h2>
          <div className="field">
            <label>Your name</label>
            <input className="input" type="text" value={editName} onChange={(e) => setEditName(e.target.value)} />
          </div>
          <button className="btn mt16" onClick={handleSaveName} disabled={loading}>
            {loading ? "Saving…" : "Save"}
          </button>
        </div>
      </Sheet>

      {/* Terms sheet */}
      <Sheet open={showTerms} onClose={() => setShowTerms(false)}>
        <div className="pad">
          <h2 style={{ marginBottom: "12px" }}>Terms & policies</h2>
          <div className="card pad">
            <div className="h-sm">Service & turnaround</div>
            <p className="muted mt4" style={{ fontSize: "13px" }}>Standard orders are ready in 2 days; express in 1 day (₹100 surcharge). You'll get a pickup code when your order is ready.</p>
            <div className="divider" />
            <div className="h-sm">Compensation policy</div>
            <p className="muted mt4" style={{ fontSize: "13px" }}>Damaged, stained or missing garments are compensated as store credits (or cash at the manager's discretion) after counter verification. Free re-dos for unsatisfactory cleaning.</p>
            <div className="divider" />
            <div className="h-sm">Payments & refunds</div>
            <p className="muted mt4" style={{ fontSize: "13px" }}>Pay by UPI, cash at the counter, or store credits. Refunds are returned the way you paid or as credits, with a GST credit note where an invoice was issued.</p>
          </div>
          <button className="btn sec mt16" onClick={() => setShowTerms(false)}>Close</button>
        </div>
      </Sheet>
    </>
  );
}
