/* Empty the browser's Cache Storage (what the service worker fills with pages
   the user has opened, including logged-in ones). Called on sign-out so the next
   person on a shared phone or the counter tablet can't open the previous user's
   pages from the offline cache. Never throws: a blocked or missing Cache API must
   not get in the way of signing out. The offline order queue is not in Cache
   Storage and is deliberately left alone. */
export async function clearOfflineCaches(): Promise<void> {
  try {
    if (typeof caches === "undefined") return;
    await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
  } catch {
    /* best effort */
  }
}
