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
    setStandalone(window.matchMedia("(display-mode: standalone)").matches);
    const onPrompt = (e: Event) => { e.preventDefault(); setDeferred(e as BIPEvent); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
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
