/* FabricFold service worker — offline shell + Web Push. Network-first for
   navigations so deploys show up without manual refresh. */
const CACHE = "ff-v33";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.pathname.startsWith("/api/")) return; // never cache API / SSE
  e.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res && res.status === 200 && url.origin === self.location.origin) {
          const c = await caches.open(CACHE);
          c.put(req, res.clone());
        }
        return res;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") {
          // Fall back to THIS app's own shell, not unconditionally "/" — that's
          // the public marketing site, not either installed app. A staff
          // member offline under /s (or a customer under /c) hitting a cache
          // miss must land back in their own app, not get bounced out of it.
          const shell = url.pathname.startsWith("/s") ? "/s" : url.pathname.startsWith("/c") ? "/c" : "/";
          const idx = (await caches.match(shell)) || (await caches.match("/"));
          if (idx) return idx;
        }
        return Response.error();
      }
    })()
  );
});

self.addEventListener("push", (e) => {
  let data = { title: "FabricFold", body: "" };
  try { data = e.data.json(); } catch { /* ignore */ }
  e.waitUntil(self.registration.showNotification(data.title || "FabricFold", { body: data.body || "", icon: "/icon-192.png", badge: "/icon-192.png" }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then((cl) => {
      for (const c of cl) if ("focus" in c) return c.focus();
      if (self.clients.openWindow) return self.clients.openWindow("/");
    })
  );
});
