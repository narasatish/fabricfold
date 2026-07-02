"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { Sheet } from "@/components/chrome";
import { logout } from "@/lib/actions/auth";

export default function ProfileClient({ studentName }: { studentName: string }) {
  const router = useRouter();
  const toast = useToast();
  const [showEditName, setShowEditName] = useState(false);
  const [editName, setEditName] = useState(studentName);
  const [loading, setLoading] = useState(false);

  const handleEditName = () => {
    setEditName(studentName);
    setShowEditName(true);
  };

  const handleSaveName = async () => {
    // TODO: implement saveName action
    setShowEditName(false);
    toast("Saved");
  };

  const handleLogout = async () => {
    setLoading(true);
    await logout();
    setLoading(false);
    router.push("/login");
  };

  return (
    <>
      <button
        className="list-item tap"
        style={{ width: "100%", textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: "15px 18px" }}
        onClick={handleEditName}
      >
        <span style={{ color: "var(--teal)" }}>
          <Svg name="edit" size={20} />
        </span>
        <div style={{ flex: 1 }}>
          <div className="h-sm">Edit name</div>
        </div>
        <Svg name="chevR" size={18} />
      </button>

      <Sheet open={showEditName} onClose={() => setShowEditName(false)}>
        <div className="h-md" style={{ padding: "0 4px 12px" }}>
          Edit name
        </div>
        <input
          className="input"
          type="text"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          style={{ marginBottom: "16px" }}
        />
        <button className="btn mt16" onClick={handleSaveName} disabled={loading}>
          {loading ? "Saving…" : "Save"}
        </button>
      </Sheet>
    </>
  );
}
