"use client";
/* One install-prompt listener for the whole site, not three.

   Chrome fires `beforeinstallprompt` ONCE per page load, and only whichever
   listener is attached AT THAT MOMENT sees it. Before this file, three
   separate components — the /c and /s in-app banner, the /get install
   button, the /login hint — each attached their OWN listener when THEY
   mounted. A QR scan lands on /get; if Chrome decided to fire the event
   while root layout was still mounting (before OrderNewClient-style child
   components exist), /get's own listener was never attached in time and the
   button silently never armed — exactly "I scanned and saw nothing".

   Fix: ONE listener, attached from the root layout — the earliest point any
   page can run client code — mounted on every page including /get and
   /login. It stores the event in a module-level singleton (survives across
   whichever component asks) and re-broadcasts it as a DOM CustomEvent so any
   mounted component can react immediately, and any component that mounts
   LATER can still ask "is one already waiting?" via getDeferredPrompt().

   Also unifies the "already installed" flag — the old three components used
   two different localStorage keys, so installing from one path did not
   silence the prompt on another. */

export type BIPEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

const FLAG = "ff-installed";
const EVT_AVAILABLE = "ff:bip-available";
const EVT_INSTALLED = "ff:bip-installed";

let deferred: BIPEvent | null = null;
let armed = false;

function persistInstalled(v: boolean) {
  try {
    if (v) localStorage.setItem(FLAG, "1");
    else localStorage.removeItem(FLAG);
  } catch {
    /* private mode — the in-memory state for this page load still works */
  }
}

/** Call ONCE, as early as possible (root layout). Idempotent. */
export function armInstallListener() {
  if (armed || typeof window === "undefined") return;
  armed = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e as BIPEvent;
    persistInstalled(false); // a fresh offer means the app isn't installed here
    window.dispatchEvent(new CustomEvent(EVT_AVAILABLE));
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    persistInstalled(true);
    window.dispatchEvent(new CustomEvent(EVT_INSTALLED));
  });
}

/** True if running as the installed app, or installed earlier in this browser. */
export function isInstalled(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia("(display-mode: standalone)").matches) return true;
  try {
    return localStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

/** The captured event, if Chrome has offered one this page load. */
export function getDeferredPrompt(): BIPEvent | null {
  return deferred;
}

/** Fire the native install dialog. Clears the singleton either way — a used
    or dismissed prompt cannot be replayed, so holding onto it invites a
    stale second tap that silently does nothing. */
export async function promptInstall() {
  const p = deferred;
  deferred = null;
  if (!p) return "no-prompt" as const;
  await p.prompt();
  const choice = await p.userChoice.catch(() => null);
  return choice?.outcome ?? "dismissed";
}

/** Subscribe to "a prompt is now available" / "the app was just installed".
    Returns an unsubscribe function. */
export function onInstallEvent(kind: "available" | "installed", cb: () => void) {
  const name = kind === "available" ? EVT_AVAILABLE : EVT_INSTALLED;
  window.addEventListener(name, cb);
  return () => window.removeEventListener(name, cb);
}
