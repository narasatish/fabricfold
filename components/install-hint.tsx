"use client";
/* A compact install affordance for the sign-in page — a QR scan can land
   here instead of /get, and the download must still be one tap away.

   Reads the SAME site-wide singleton as /get's InstallButton (lib/pwa-
   install.ts). Previously this had its own listener, which raced against
   /get's listener and the /c-and-/s banner's listener for the SAME one-time
   browser event — three chances to miss it instead of one guaranteed catch. */
import { useEffect, useState } from "react";
import Link from "next/link";
import { getDeferredPrompt, isInstalled, onInstallEvent, promptInstall } from "@/lib/pwa-install";

export default function InstallHint() {
  const [ready, setReady] = useState(false);
  const [standalone, setStandalone] = useState(true); // assume installed until proven otherwise

  useEffect(() => {
    setStandalone(isInstalled());
    setReady(!!getDeferredPrompt());
    const offAvail = onInstallEvent("available", () => { setStandalone(false); setReady(!!getDeferredPrompt()); });
    const offInstalled = onInstallEvent("installed", () => setStandalone(true));
    return () => { offAvail(); offInstalled(); };
  }, []);

  if (standalone) return null;

  return (
    <div className="center mt16" style={{ fontSize: 13 }}>
      {ready ? (
        <button
          className="btn ghost"
          style={{ width: "auto", padding: "8px 18px" }}
          onClick={async () => { const r = await promptInstall(); if (r === "accepted") setStandalone(true); else setReady(false); }}
        >
          ⬇ Install the app — one tap
        </button>
      ) : (
        <Link href="/get" className="muted" style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>
          📲 Get the app on your phone
        </Link>
      )}
    </div>
  );
}
