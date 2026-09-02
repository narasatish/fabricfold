"use client";
/* One-tap install.

   The browser will not install a PWA without a user gesture, and iOS Safari
   has no install API at all — so "scan → app on the phone" is, at its best,
   scan → ONE tap. This captures Chrome/Android's beforeinstallprompt and
   turns it into that single tap; platforms that refuse the API fall back to
   the written steps below, which stay on the page for exactly that reason. */
import { useEffect, useState } from "react";

type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

export default function InstallButton() {
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  const [state, setState] = useState<"waiting" | "ready" | "installed" | "unsupported">("waiting");

  useEffect(() => {
    // Already running as the installed app, or installed earlier from this
    // browser? Nothing to sell — offer Open instead (owner: never re-ask).
    let was = false;
    try { was = localStorage.getItem("ff-installed") === "1"; } catch { /* private mode */ }
    if (window.matchMedia("(display-mode: standalone)").matches || was) { setState("installed"); return; }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      try { localStorage.removeItem("ff-installed"); } catch { /* ignore */ }
      setDeferred(e as BIPEvent);
      setState("ready");
    };
    const onInstalled = () => { try { localStorage.setItem("ff-installed", "1"); } catch { /* ignore */ } setState("installed"); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    /* If Chrome hasn't offered within a few seconds it isn't going to —
       wrong browser, iOS, or already installed under another profile. Show
       the manual path rather than a button that will never arm. */
    const t = setTimeout(() => setState((s) => (s === "waiting" ? "unsupported" : s)), 3500);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
      clearTimeout(t);
    };
  }, []);

  if (state === "installed") {
    return <a className="btn mt16" href="/login">Open FabricFold</a>;
  }
  if (state === "ready" && deferred) {
    return (
      <button
        className="btn mt16"
        onClick={async () => { await deferred.prompt(); }}
        style={{ fontSize: 17 }}
      >
        ⬇ Install FabricFold — one tap
      </button>
    );
  }
  if (state === "waiting") {
    return <button className="btn mt16" disabled>Checking your phone…</button>;
  }
  // unsupported: the written iPhone/Android steps above are the path
  return null;
}
