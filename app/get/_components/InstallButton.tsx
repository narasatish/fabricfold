"use client";
/* One-tap install — reads the SITE-WIDE singleton (lib/pwa-install.ts).

   iPhone has no install event to wait for — Apple provides no install API
   in Safari at all, ever, on any iOS version. The old version waited 4
   seconds "Checking your phone…" before giving up on EVERY phone, which on
   an iPhone reads as the page being stuck or broken for four full seconds
   before finally showing the real instructions underneath. Detected
   up front now: an iPhone skips straight to nothing (the page's own iPhone
   card, unconditionally rendered, is the true and only path), so nothing
   ever looks like it's hanging on a device where "checking" was always
   going to fail. */
import { useEffect, useState } from "react";
import { getDeferredPrompt, isInstalled, onInstallEvent, promptInstall } from "@/lib/pwa-install";

function isIosSafari() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iphone|ipad|ipod/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
}

export default function InstallButton() {
  const [state, setState] = useState<"waiting" | "ready" | "installed" | "unsupported">("waiting");

  useEffect(() => {
    if (isInstalled()) { setState("installed"); return; }
    if (isIosSafari()) { setState("unsupported"); return; } // no event to wait for — ever
    if (getDeferredPrompt()) { setState("ready"); return; }

    const offAvail = onInstallEvent("available", () => setState(getDeferredPrompt() ? "ready" : "waiting"));
    const offInstalled = onInstallEvent("installed", () => setState("installed"));

    /* If nothing arrives within a few seconds it isn't going to — wrong
       browser, or the offer already fired and was consumed elsewhere in
       this session. Show the manual path below rather than a dead button. */
    const t = setTimeout(() => setState((s) => (s === "waiting" ? "unsupported" : s)), 4000);
    return () => { offAvail(); offInstalled(); clearTimeout(t); };
  }, []);

  if (state === "installed") {
    return <a className="btn mt16" href="/login">Open FabricFold</a>;
  }
  if (state === "ready") {
    return (
      <button
        className="btn mt16"
        onClick={async () => { const r = await promptInstall(); if (r === "accepted") setState("installed"); }}
        style={{ fontSize: 17 }}
      >
        ⬇ Install FabricFold — one tap
      </button>
    );
  }
  if (state === "waiting") {
    return <button className="btn mt16" disabled>Checking your phone…</button>;
  }
  // unsupported: the written iPhone/Android steps on this page are the path
  return null;
}
