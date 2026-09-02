"use client";
/* Registers the service worker + Web Push subscription (when VAPID key is set),
   and arms the site-wide install listener as early as any client code can
   run — see lib/pwa-install.ts for why "as early as possible" is the fix. */
import { useEffect, useState } from "react";
import { armInstallListener, getDeferredPrompt, isInstalled, onInstallEvent, promptInstall, type BIPEvent } from "@/lib/pwa-install";

export function PwaSetup({ vapidPublicKey }: { vapidPublicKey?: string }) {
  useEffect(() => {
    armInstallListener();
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").then(async (reg) => {
      if (!vapidPublicKey || !("PushManager" in window)) return;
      try {
        if (Notification.permission === "default") await Notification.requestPermission();
        if (Notification.permission !== "granted") return;
        const existing = await reg.pushManager.getSubscription();
        const sub =
          existing ||
          (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
          }));
        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sub),
        });
      } catch {
        /* push unsupported / denied — in-app + SSE still work */
      }
    }).catch(() => {});
  }, [vapidPublicKey]);
  return null;
}

/* ---------- Install-to-home-screen banner (shown post-login, on /c and /s) ----------
   Reads the SHARED singleton — armed on every page from the root layout — so
   it shows the offer even when Chrome fired it before this banner mounted
   (e.g. the student was still on /login when the event arrived). iOS Safari
   never fires the event, so it gets the manual Share hint instead. Dismissal
   is remembered for 14 days; installing is remembered for good via the
   shared "ff-installed" flag (lib/pwa-install.ts), same flag /get uses, so
   installing from EITHER surface silences BOTH. */
const DISMISS_KEY = "ff_install_dismissed";
const DISMISS_DAYS = 14;

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BIPEvent | null>(null);
  const [iosHint, setIosHint] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (isInstalled()) return;

    try {
      const until = Number(localStorage.getItem(DISMISS_KEY) || 0);
      if (until && Date.now() < until) return;
    } catch { /* ignore */ }

    const existing = getDeferredPrompt();
    if (existing) { setDeferred(existing); setVisible(true); }
    const off = onInstallEvent("available", () => {
      const p = getDeferredPrompt();
      if (p) { setDeferred(p); setVisible(true); }
    });
    const offInstalled = onInstallEvent("installed", () => setVisible(false));

    // iOS Safari: no beforeinstallprompt — detect and show the manual hint.
    const ua = navigator.userAgent;
    const isIos = /iphone|ipad|ipod/i.test(ua);
    const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
    if (isIos && isSafari) {
      setIosHint(true);
      setVisible(true);
    }

    return () => { off(); offInstalled(); };
  }, []);

  const dismiss = () => {
    setVisible(false);
    try { localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_DAYS * 864e5)); } catch { /* ignore */ }
  };

  const install = async () => {
    await promptInstall();
    setDeferred(null);
    dismiss();
  };

  if (!visible) return null;

  return (
    <div
      role="dialog"
      aria-label="Install FabricFold"
      style={{
        position: "fixed", left: 12, right: 12, bottom: "calc(72px + env(safe-area-inset-bottom))",
        zIndex: 60, background: "var(--card, #fff)", border: "1px solid var(--line, #dfe7e3)",
        borderRadius: 16, boxShadow: "0 10px 30px rgba(0,0,0,.15)", padding: "13px 14px",
        display: "flex", alignItems: "center", gap: 12, maxWidth: 460, margin: "0 auto",
        animation: "ff-rise .28s cubic-bezier(.2,.8,.2,1)",
      }}
    >
      <img src="/icon-192.png" alt="" width={40} height={40} style={{ borderRadius: 10, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 650, fontSize: 14 }}>Install FabricFold</div>
        <div style={{ color: "var(--muted, #71827b)", fontSize: 12, lineHeight: 1.35 }}>
          {iosHint
            ? "Tap the Share button, then “Add to Home Screen”."
            : "Add it to your home screen for one-tap access."}
        </div>
      </div>
      {!iosHint && (
        <button
          onClick={install}
          style={{ background: "var(--teal, #0e9271)", color: "#fff", border: "none", borderRadius: 11, height: 38, padding: "0 16px", fontWeight: 650, fontSize: 13.5, flexShrink: 0 }}
        >Install</button>
      )}
      <button onClick={dismiss} aria-label="Dismiss" style={{ background: "none", border: "none", color: "var(--muted, #71827b)", fontSize: 20, lineHeight: 1, padding: "4px 6px", flexShrink: 0 }}>×</button>
    </div>
  );
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
