"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/chrome";
import { Svg } from "@/components/icons";
import { rateOrder, deleteDraft } from "@/lib/actions/orders";

export default function OrderDetailClient({
  orderId,
  initialRating,
  isDraft,
}: {
  orderId: string;
  initialRating?: number;
  isDraft?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [rating, setRating] = useState(initialRating || 0);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmitRating = async () => {
    setLoading(true);
    const r = await rateOrder(orderId, rating, comment);
    setLoading(false);
    if (!r.ok) {
      toast(r.error, true);
      return;
    }
    toast("Rating submitted");
    router.refresh();
  };

  const handleDeleteDraft = async () => {
    if (!confirm("Delete this draft order?")) return;
    setLoading(true);
    const r = await deleteDraft(orderId);
    setLoading(false);
    if (!r.ok) {
      toast(r.error || "Could not delete", true);
      return;
    }
    toast("Draft deleted");
    router.push("/c/orders");
  };

  if (isDraft) {
    return (
      <button className="btn sec mt16 danger" style={{ color: "var(--red)", background: "var(--red-soft)", border: "none" }} onClick={handleDeleteDraft} disabled={loading}>
        <Svg name="trash" size={17} /> Delete draft
      </button>
    );
  }

  return (
    <div className="card pad mt16">
      <div className="label">{rating ? "Your rating" : "Rate this order"}</div>
      <div className="stars mt8">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            className={rating >= n ? "on" : ""}
            onClick={() => setRating(n)}
            style={{ fontSize: "30px", lineHeight: 1, color: rating >= n ? "#e8a92b" : "var(--line-2)", transition: ".1s" }}
          >
            {rating >= n ? "★" : "☆"}
          </button>
        ))}
      </div>
      {rating > 0 && (
        <>
          <textarea
            className="input mt12"
            placeholder="Tell us more (optional)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            style={{ minHeight: "88px" }}
          />
          <button className="btn sm mt10" style={{ width: "auto" }} onClick={handleSubmitRating} disabled={loading}>
            {loading ? "Submitting…" : "Submit feedback"}
          </button>
        </>
      )}
    </div>
  );
}
