"use client";
/* Registers the service worker + Web Push subscription (when VAPID key is set). */
import { useEffect } from "react";

export function PwaSetup({ vapidPublicKey }: { vapidPublicKey?: string }) {
  useEffect(() => {
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

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
