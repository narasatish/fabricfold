/* Web-push subscription endpoints. The server later POSTs notifications to the
   stored URL, so accepting an arbitrary one lets a logged-in user aim the server
   at internal addresses (blind SSRF). A genuine endpoint is https on one of the
   browser push services, default port, no credentials in the URL. */
const PUSH_HOSTS = [
  "fcm.googleapis.com",            // Chrome / Android / Edge (FCM)
  "android.googleapis.com",        // legacy GCM
  "updates.push.services.mozilla.com", // Firefox
  "push.services.mozilla.com",
  "push.apple.com",                // Safari / iOS (web.push.apple.com and regional)
  "notify.windows.com",            // Windows / Edge (wns2-*.notify.windows.com)
];

export function isPushEndpoint(v: unknown): boolean {
  if (typeof v !== "string" || v.length === 0 || v.length > 1000) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.some((h) => host === h || host.endsWith("." + h));
}
