"use client";
import { report } from "@/components/error-reporter";
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

/* Catches errors in the root layout itself. Must render <html>/<body>. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { report(error); Sentry.captureException(error); }, [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", display: "grid", placeItems: "center", minHeight: "100vh", margin: 0, background: "#f4f7f5", color: "#0f1f19" }}>
        <div style={{ textAlign: "center", padding: 24 }}>
          <div style={{ fontSize: 44 }}>😅</div>
          <h2 style={{ margin: "12px 0 4px" }}>Something went wrong</h2>
          <p style={{ color: "#71827b", fontSize: 14 }}>We&apos;ve been notified. Please try again.</p>
          <button onClick={reset} style={{ marginTop: 16, background: "#0e9271", color: "#fff", border: "none", borderRadius: 12, height: 46, padding: "0 26px", fontWeight: 650, fontSize: 15 }}>Try again</button>
        </div>
      </body>
    </html>
  );
}
