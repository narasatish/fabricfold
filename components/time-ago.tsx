"use client";
/* Relative time ("5m ago") that can't cause a hydration mismatch.

   timeAgo() reads the clock, so the server's "just now" and the browser's
   "1m ago" a moment later disagree whenever a minute boundary falls between
   the two — React then throws the server HTML away and rebuilds the tree on
   the client (and logs a hydration error). Rendering the same empty string on
   the server and on the first client render removes the disagreement; the real
   text fills in right after mount and refreshes every minute. */
import { useEffect, useState } from "react";
import { timeAgo } from "@/lib/format";

export function TimeAgo({ at }: { at: Date | number | string }) {
  const ms = new Date(at).getTime();
  const [text, setText] = useState("");
  useEffect(() => {
    setText(timeAgo(ms));
    const i = setInterval(() => setText(timeAgo(ms)), 60_000);
    return () => clearInterval(i);
  }, [ms]);
  return <span suppressHydrationWarning>{text}</span>;
}
