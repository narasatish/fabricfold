"use client";
/* Reports an error to /api/error (fire-and-forget) and shows a friendly
   retry screen. Used by app/error.tsx and app/global-error.tsx. */
import { useEffect } from "react";

export function report(error: Error, url?: string) {
  try {
    navigator.sendBeacon?.(
      "/api/error",
      new Blob([JSON.stringify({ message: error.message, stack: error.stack, url: url || location.href, kind: "client" })], { type: "application/json" }),
    ) ||
      fetch("/api/error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: error.message, stack: error.stack, url: url || location.href, kind: "client" }),
        keepalive: true,
      }).catch(() => {});
  } catch {
    /* never let reporting throw */
  }
}

export function ErrorScreen({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => { report(error); }, [error]);
  return (
    <div className="screen no-nav">
      <div className="empty" style={{ paddingTop: "22vh" }}>
        <div style={{ fontSize: 44 }}>😅</div>
        <div className="h-md mt12">Something went wrong</div>
        <div className="muted mt4" style={{ fontSize: 13.5 }}>We&apos;ve been notified. Try again in a moment.</div>
        <button className="btn mt20" style={{ width: "auto", padding: "0 26px" }} onClick={reset}>Try again</button>
      </div>
    </div>
  );
}
