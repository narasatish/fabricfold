"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { submitComplaint } from "@/lib/actions/complaints";
import { compressImage } from "@/lib/compress-image";
import { MIN_DAMAGE_PHOTOS, MAX_PHOTOS_PER_MESSAGE } from "@/lib/complaint-rules";

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
    if (photos.length >= MAX_PHOTOS_PER_MESSAGE) {
      toast(`Up to ${MAX_PHOTOS_PER_MESSAGE} photos`, true);
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      // shrink on-device first: a raw phone photo is 3-12 MB, which is slow to
      // upload and was exhausting serverless memory on the receiving end
      const { file: upload } = await compressImage(file);
      fd.append("file", upload);
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
    try {
      const r = await submitComplaint(complaintText, orderId || null, photos);
      if (!r.ok) {
        toast(r.error || "Could not submit", true);
        return;
      }
      toast("Complaint submitted");
      setComplaintText("");
      setPhotos([]);
      router.refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not submit", true);
    } finally {
      setLoading(false);
    }
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
        <Svg name="camera" size={16} /> {uploading
          ? "Uploading…"
          : photos.length >= MIN_DAMAGE_PHOTOS
            ? `Add another photo (${photos.length})`
            : `Add photo ${photos.length + 1} of ${MIN_DAMAGE_PHOTOS}`}
        {/* No `capture` attribute (owner, Sep 2026): capture="environment"
            forces the camera app open directly on most mobile browsers,
            skipping the OS's own picker — so a student with an EXISTING
            photo of the stain/damage had no way to attach it, only to take a
            fresh one. Removing it restores the native chooser (Camera /
            Photo Library / Files on iOS, Camera / Gallery on Android),
            covering both "take a new photo" and "upload one I already have"
            with a single, normal file input. */}
        <input
          type="file"
          accept="image/*"
          hidden
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void addPhoto(f);
            e.target.value = "";
          }}
        />
      </label>

      {/* The requirement is stated before they write, and the button explains
          what is missing rather than just sitting greyed out — a disabled
          control with no reason is how people give up on reporting a problem. */}
      <div className="muted mt8" style={{ fontSize: 12 }}>
        {photos.length >= MIN_DAMAGE_PHOTOS
          ? `${photos.length} photos attached — these are what settle the claim.`
          : `At least ${MIN_DAMAGE_PHOTOS} photos are needed. They are the evidence if we have to make this right, and a washed garment cannot be photographed later.`}
      </div>
      <button
        className="btn mt12"
        onClick={handleSubmitComplaint}
        disabled={loading || uploading || photos.length < MIN_DAMAGE_PHOTOS || !complaintText.trim()}
      >
        {loading
          ? "Submitting…"
          : photos.length < MIN_DAMAGE_PHOTOS
            ? `Add ${MIN_DAMAGE_PHOTOS - photos.length} more photo${MIN_DAMAGE_PHOTOS - photos.length === 1 ? "" : "s"}`
            : !complaintText.trim()
              ? "Describe the issue"
              : "Submit complaint"}
      </button>
    </div>
  );
}
