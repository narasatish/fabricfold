"use client";
/* A compact install affordance for pages a QR scan can land on.

   The owner scanned the poster and ended up staring at the sign-in page with
   no download in sight — the /get page has the full installer, but phones
   take their own routes (in-app browsers, captured links into an installed
   app, plain Chrome), and the fix that survives all of them is for sign-in
   itself to carry the shortcut.

   Chrome/Android arms the native one-tap dialog; everything else gets a
   plain link to /get, where the written steps live. Running inside the
   already-installed app shows nothing — there is nothing to sell. */
import { useEffect, useState } from "react";
import Link from "next/link";

type BIPEvent = Event & { prompt: () => Promise<void> };

export default function InstallHint() {
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  const [standalone, setStandalone] = useState(true); // assume installed until proven otherwise

  useEffect(() => {
    /* Once installed, never ask again (owner). appinstalled sets a flag;
       display-mode covers being INSIDE the app. If Chrome later fires
       beforeinstallprompt again, the app was uninstalled — the flag clears,
       because a hint that never comes back after a reinstall is as wrong as
       one that never goes away. */
    let installed = false;
    try { installed = localStorage.getItem("ff-installed") === "1"; } catch { /* private mode */ }
    setStandalone(window.matchMedia("(display-mode: standalone)").matches || installed);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      try { localStorage.removeItem("ff-installed"); } catch { /* ignore */ }
      setStandalone(false);
      setDeferred(e as BIPEvent);
    };
    const onInstalled = () => {
      try { localStorage.setItem("ff-installed", "1"); } catch { /* ignore */ }
      setStandalone(true);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => { window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  if (standalone) return null;

  return (
    <div className="center mt16" style={{ fontSize: 13 }}>
      {deferred ? (
        <button
          className="btn ghost"
          style={{ width: "auto", padding: "8px 18px" }}
          onClick={() => void deferred.prompt()}
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
