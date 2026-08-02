"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { submitComplaint } from "@/lib/actions/complaints";

export default function HelpClient({ orderId }: { orderId?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [complaintText, setComplaintText] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(false);

  // A photo of the damage says more than a paragraph about it, and it lands in
  // the same thread staff review.
  const addPhoto = async (file: File) => {
    if (photos.length >= 6) {
      toast("Up to 6 photos", true);
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload/complaint", { method: "POST", body: fd });
      if (!res.ok) {
        toast((await res.text()) || "Upload failed", true);
        return;
      }
      const j = (await res.json()) as { key: string };
      setPhotos((p) => [...p, j.key]);
    } catch {
      toast("Upload failed", true);
    } finally {
      setUploading(false);
    }
  };

  const handleSubmitComplaint = async () => {
    if (!complaintText.trim()) {
      toast("Please describe the issue", true);
      return;
    }
    setLoading(true);
    const r = await submitComplaint(complaintText, orderId || null, photos);
    setLoading(false);
    if (!r.ok) {
      toast(r.error || "Could not submit", true);
      return;
    }
    toast("Complaint submitted");
    setComplaintText("");
    setPhotos([]);
    router.refresh();
  };

  return (
    <div className="card pad">
      <textarea
        className="input"
        placeholder="Describe the issue — missing item, quality, delay…"
        value={complaintText}
        onChange={(e) => setComplaintText(e.target.value)}
        style={{ minHeight: "88px" }}
      />

      {photos.length > 0 && (
        <div className="row wrap gap8" style={{ marginTop: "10px" }}>
          {photos.map((key, i) => (
            <div key={key} style={{ position: "relative" }}>
              <img
                src={`/api/complaint-photo?key=${encodeURIComponent(key)}`}
                alt={`Photo ${i + 1}`}
                style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)" }}
              />
              <button
                onClick={() => setPhotos((p) => p.filter((k) => k !== key))}
                aria-label="Remove photo"
                style={{ position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: "50%", background: "var(--red)", color: "#fff", border: "none", fontSize: 12, lineHeight: 1, display: "grid", placeItems: "center" }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <label className="btn sec mt12" style={{ cursor: "pointer" }}>
        <Svg name="camera" size={16} /> {uploading ? "Uploading…" : photos.length ? "Add another photo" : "Add a photo (optional)"}
        <input
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void addPhoto(f);
            e.target.value = "";
          }}
        />
      </label>

      <button className="btn mt12" onClick={handleSubmitComplaint} disabled={loading || uploading}>
        {loading ? "Submitting…" : "Submit complaint"}
      </button>
    </div>
  );
}
