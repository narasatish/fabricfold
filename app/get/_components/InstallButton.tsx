"use client";
/* One-tap install — reads the SITE-WIDE singleton (lib/pwa-install.ts).

   Chrome fires beforeinstallprompt once per page load; root layout arms the
   listener the instant it mounts, so by the time this button renders, an
   already-captured event is picked up immediately via getDeferredPrompt() —
   no missed-event race, no separate local listener that could lose to
   timing. This was a scan-and-see-nothing bug: this component used to attach
   its OWN listener, and if Chrome fired the event a beat earlier, nobody was
   listening yet. */
import { useEffect, useState } from "react";
import { getDeferredPrompt, isInstalled, onInstallEvent, promptInstall } from "@/lib/pwa-install";

export default function InstallButton() {
  const [state, setState] = useState<"waiting" | "ready" | "installed" | "unsupported">("waiting");

  useEffect(() => {
    if (isInstalled()) { setState("installed"); return; }
    if (getDeferredPrompt()) { setState("ready"); return; }

    const offAvail = onInstallEvent("available", () => setState(getDeferredPrompt() ? "ready" : "waiting"));
    const offInstalled = onInstallEvent("installed", () => setState("installed"));

    /* If nothing arrives within a few seconds it isn't going to — wrong
       browser, iOS, or the offer already fired and was consumed elsewhere in
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
