"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/chrome";
import { Svg } from "@/components/icons";

export default function HelpClient({ orderId }: { orderId?: string }) {
  const router = useRouter();
  const toast = useToast();
  const [complaintText, setComplaintText] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmitComplaint = async () => {
    if (!complaintText.trim()) {
      toast("Please describe the issue", true);
      return;
    }
    setLoading(true);
    // TODO: implement submitComplaint action
    setLoading(false);
    toast("Complaint submitted");
    setComplaintText("");
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
      <button className="btn mt12" onClick={handleSubmitComplaint} disabled={loading}>
        {loading ? "Submitting…" : "Submit complaint"}
      </button>
    </div>
  );
}
